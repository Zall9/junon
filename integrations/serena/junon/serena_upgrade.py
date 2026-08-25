"""Take a Serena release only if the installation still works afterwards — and undo it if not.

JUNON is composed onto an unmodified Serena that arrives from a channel knowing nothing about JUNON.
Two breaks on this machine came through exactly that door: 1.5.3 changed the signature of
`run_in_thread` and JUNON's override killed the agent at start-up, and a config schema change made 26
of 27 projects unloadable. A version number showed neither.

So the upgrade is not "install and hope". It is:

    baseline -> upgrade -> prove it still works -> if not, put the old one back and prove that

**The baseline comes first, and it can refuse the whole thing.** If the installation is already
broken, an upgrade cannot be blamed for it and a rollback would restore something that was not
working either. Better to say so and stop.

**What "works" means here is behavioural, and it has to be.** The repository's own test suite runs
against a *checkout* of Serena (`serena-upstream/`, 1.7.1.dev0 today), not against the pipx venv that
actually serves JUNON (1.7.0) — a green suite says nothing about the installation this script is
changing. So the check starts the real `junon` binary, waits for its dashboard, and asks it which
tools it registered. Ten `ide_*` tools present means the composition survived; anything else, including
"could not tell", is not a pass.

**Injection is restored explicitly.** JUNON lives in Serena's pipx venv as an editable injected
package. `pipx upgrade` keeps injections; `pipx install --force` — which is how a rollback pins an
older version — recreates the venv and drops them. The spec is read back from pipx's own metadata and
re-injected after every mutation, so a rollback restores what was there rather than what this file
guessed.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from junon.serena_release import check as check_versions
from junon.serena_release import installed_version

PIPX_METADATA = Path.home() / ".local/pipx/venvs/serena-agent/pipx_metadata.json"
JUNON_BIN = Path.home() / ".local/bin/junon"

#: How many `ide_*` tools a working composition registers. Ten today; the check is "at least", so
#: adding one does not fail an upgrade, and losing them all — the shape of every composition break so
#: far — does.
EXPECTED_IDE_TOOLS = 8

#: Long enough for a cold start with language servers, short enough that a hung start is a failure
#: rather than a wait.
START_TIMEOUT_SECONDS = 180

_DASHBOARD = re.compile(r"http://127\.0\.0\.1:(\d+)/dashboard")


@dataclass(frozen=True, slots=True)
class Step:
    name: str
    ok: bool
    detail: str = ""

    def __str__(self) -> str:
        return f"{'ok  ' if self.ok else 'FAIL'} {self.name:28} {self.detail}"


@dataclass
class Outcome:
    steps: list[Step] = field(default_factory=list)
    upgraded_to: str = ""
    rolled_back_to: str = ""
    #: Set when the rollback itself did not restore a working installation. The loudest state this
    #: script has, and the only one that leaves the machine worse than it found it.
    stranded: bool = False

    @property
    def ok(self) -> bool:
        return all(step.ok for step in self.steps)

    def add(self, step: Step) -> Step:
        self.steps.append(step)
        print(f"  {step}", flush=True)
        return step


#: What makes a forced reinstall actually replace the venv.
#:
#: pipx builds venvs with uv, and uv refuses to replace a directory it did not create in this session:
#: `pipx install --force` fails with "A virtual environment already exists at: ." and installs
#: nothing. `--force` is pipx's flag and never reaches uv's refusal. Measured in an isolated pipx home
#: on 2026-08-25, so it is the tool's behaviour rather than this machine's.
FORCE_ENVIRONMENT = {"UV_VENV_CLEAR": "1"}


def _run(command: list[str], timeout: int = 900, force: bool = False) -> tuple[int, str]:
    environment = {**os.environ, **FORCE_ENVIRONMENT} if force else None
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, env=environment
        )
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, (done.stdout + done.stderr).strip()


def injected_specs() -> list[list[str]]:
    """The injected packages as pipx recorded them, so they can be put back exactly.

    Read rather than assumed: this is what makes a rollback restore *this* machine's JUNON — an
    editable checkout at whatever path it actually lives — instead of a guess.
    """
    try:
        metadata = json.loads(PIPX_METADATA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    specs = []
    for info in (metadata.get("injected_packages") or {}).values():
        spec = info.get("package_or_url")
        if not spec:
            continue
        arguments = [str(spec), *(info.get("pip_args") or [])]
        # pipx records this separately from `pip_args`, and without it the entry points land inside
        # the venv and are never exposed on PATH. Re-injecting without it restores a working library
        # and removes the `junon` command every agent host launches — which is how a rollback can
        # report success and leave nothing runnable.
        if info.get("include_apps"):
            arguments.append("--include-apps")
        specs.append(arguments)
    return specs


def smoke(project: Path) -> Step:
    """Start the real thing and ask it what it registered.

    Not a unit test and not the repository's suite: those run against a checkout. This runs the
    binary a user's agent host runs, against the venv this script is about to change.
    """
    if not JUNON_BIN.exists():
        return Step("composition", False, f"{JUNON_BIN} is missing")

    process = subprocess.Popen(
        [str(JUNON_BIN), "start-mcp-server", "--project", str(project), "--transport", "stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        port = _wait_for_dashboard(process)
        if port is None:
            return Step("composition", False, "no dashboard within the timeout; the agent did not start")
        if not _port_belongs_to(process.pid, port):
            # The failure this guards against is not hypothetical: with a JUNON already running, a
            # port read from a log can be somebody else's, and asking it "are you healthy" gets a
            # cheerful yes about the wrong process — after an upgrade that broke the new one.
            return Step(
                "composition",
                False,
                f"port {port} is not served by the instance this check started; another JUNON is "
                f"running and would have answered for it",
            )
        tools = _registered_tools(port)
        if tools is None:
            return Step("composition", False, "the dashboard did not report its tools")
        ide_tools = sorted(name for name in tools if name.startswith("ide_"))
        if len(ide_tools) < EXPECTED_IDE_TOOLS:
            return Step(
                "composition",
                False,
                f"only {len(ide_tools)} ide_* tools registered ({', '.join(ide_tools) or 'none'})",
            )
        return Step("composition", True, f"{len(ide_tools)} ide_* tools registered")
    finally:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()


def _port_belongs_to(pid: int, port: int) -> bool:
    """Whether the listener on `port` is the process we started, or one of its children.

    `lsof` rather than a handshake: the dashboard has no identity endpoint, and a check that trusts
    the answer to decide whose answer it is proves nothing.
    """
    code, output = _run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], timeout=30)
    if code != 0 or not output:
        return False
    listeners = {line.strip() for line in output.splitlines() if line.strip().isdigit()}
    if str(pid) in listeners:
        return True
    # The launcher may exec a child; walk one generation, which is all this shape needs.
    code, children = _run(["pgrep", "-P", str(pid)], timeout=30)
    if code != 0:
        return False
    return bool(listeners & {line.strip() for line in children.splitlines() if line.strip()})


def _wait_for_dashboard(process: subprocess.Popen[str]) -> int | None:
    """The port, from the agent's own output. Also notices the process dying, which is the shape a
    composition break takes: it does not hang, it exits."""
    deadline = time.time() + START_TIMEOUT_SECONDS
    assert process.stdout is not None
    while time.time() < deadline:
        line = process.stdout.readline()
        if not line:
            if process.poll() is not None:
                return None
            continue
        found = _DASHBOARD.search(line)
        if found:
            return int(found.group(1))
    return None


def _registered_tools(port: int) -> list[str] | None:
    for _ in range(10):
        try:
            with urllib.request.urlopen(  # noqa: S310 - loopback, port from our own child process
                f"http://127.0.0.1:{port}/get_config_overview", timeout=10
            ) as response:
                payload = json.loads(response.read(4_000_000).decode("utf-8", "replace"))
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(2)
            continue
        for key in ("tool_names", "tools", "active_tools"):
            value = payload.get(key)
            if isinstance(value, list) and value:
                return [str(item) for item in value]
        config = payload.get("config") or {}
        value = config.get("tool_names")
        if isinstance(value, list):
            return [str(item) for item in value]
        return []
    return None


def run(project: Path, target: str = "", dry_run: bool = False) -> Outcome:
    outcome = Outcome()

    versions = check_versions()
    print(f"  {versions.summary}", flush=True)
    previous = versions.installed
    if not previous:
        outcome.add(Step("installed", False, "no pipx serena-agent to upgrade"))
        return outcome
    if not target and not versions.behind:
        outcome.add(Step("up to date", True, versions.summary))
        return outcome

    wanted = target or versions.latest
    if dry_run:
        outcome.add(Step("dry run", True, f"would take {previous} to {wanted}, and prove it or undo it"))
        return outcome

    # The baseline. An installation that is already broken cannot be made better by an upgrade, and
    # rolling back to it would restore the same break while reporting success.
    if not outcome.add(smoke(project)).ok:
        outcome.steps[-1] = Step("baseline", False, "the installation is already broken; not upgrading")
        print(f"  {outcome.steps[-1]}", flush=True)
        return outcome
    outcome.steps[-1] = Step("baseline", True, outcome.steps[-1].detail)

    code, output = _run(["pipx", "install", f"serena-agent=={wanted}", "--force"], force=True)
    if code != 0:
        outcome.add(Step("install", False, output.splitlines()[-1] if output else "pipx failed"))
        return outcome
    _reinject(outcome)
    now = installed_version()
    outcome.add(Step("install", now == wanted, f"installed {now or 'nothing'}"))
    outcome.upgraded_to = now

    if outcome.add(smoke(project)).ok:
        return outcome

    # It broke. Put back exactly what was there, and prove *that* too — a rollback nobody checked is
    # the same promise this script exists to stop making.
    print("  rolling back", flush=True)
    code, output = _run(["pipx", "install", f"serena-agent=={previous}", "--force"], force=True)
    _reinject(outcome)
    restored = installed_version()
    outcome.rolled_back_to = restored
    outcome.add(Step("rollback", restored == previous, f"restored {restored or 'nothing'}"))
    recovered = smoke(project)
    outcome.add(Step("after rollback", recovered.ok, recovered.detail))
    outcome.stranded = not recovered.ok
    return outcome


def _reinject(outcome: Outcome) -> None:
    """Put the editable JUNON back. `pipx install --force` recreates the venv and drops injections."""
    for spec in injected_specs():
        code, output = _run(["pipx", "inject", "serena-agent", *spec])
        outcome.add(Step("reinject", code == 0, spec[0] if code == 0 else output[-120:]))


def main(argv: list[str]) -> int:
    project = Path(
        next((a for a in argv if not a.startswith("-")), str(Path.cwd()))
    ).resolve()
    if "--check" in argv:
        print(f"  {check_versions().summary}")
        return 0
    target = ""
    if "--to" in argv:
        target = argv[argv.index("--to") + 1]
    outcome = run(project, target=target, dry_run="--dry-run" in argv)
    if outcome.stranded:
        print("\n  THE ROLLBACK DID NOT RESTORE A WORKING INSTALLATION — fix this before using JUNON.")
        return 2
    return 0 if outcome.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
