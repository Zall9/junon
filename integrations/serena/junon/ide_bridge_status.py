"""What the dashboard's IDE Bridge panel reports.

Deliberately read-only and deliberately shallow: it answers "is an IDE connected, and which", which
is what the panel shows. Anything the agent actually *does* with the bridge goes through the language
backend, not through here — a dashboard that could drive an IDE would be a second, unaudited path to
the same operations.

Every failure is reported as a state with a reason rather than raised. "No daemon running" and "no
IDE open" are ordinary conditions of this system, and a panel that shows an exception for them is
telling the user their dashboard is broken when it is working correctly.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Literal

#: Where the daemon publishes its endpoint and token. Overridable for tests and for the
#: non-default install layouts the CLI supports.
DISCOVERY_ENV_VAR = "IDE_BRIDGE_DISCOVERY_FILE"

Status = Literal["connected", "no-adapter", "no-daemon", "daemon-unreachable", "unreadable"]

#: Every state this module can report, and what it means. The panel must have a label for each.
STATUS_MEANINGS: dict[str, str] = {
    "connected": "an IDE has a workspace open on a daemon that answers",
    "no-adapter": "the daemon answers, and no IDE has a workspace open",
    "no-daemon": "no daemon is running — no discovery file, or one its process no longer backs",
    "daemon-unreachable": "the daemon's process is alive and its endpoint does not answer",
    "unreadable": "the discovery file could not be read or trusted",
}


def _discovery_path() -> Path:
    override = os.environ.get(DISCOVERY_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "discovery.json"


#: Short on purpose. A dashboard panel that hangs is worse than one that says it does not know, and
#: this call happens while a page is rendering.
PANEL_TIMEOUT_SECONDS = 3.0


def _disk_versions(daemon_version: str | None) -> dict[str, Any] | None:
    """A verdict from what the IDEs have installed, for when none of them is running.

    The comparison the card usually makes needs a connected adapter, and a closed IDE has none — yet
    a closed IDE is the only kind the installer can write to. Reading the jar is the same question
    asked of the disk rather than of a live process, and the answer says so.
    """
    from junon.client import JUNON_VERSION
    from junon.update_action import installed_ides, installed_version
    from junon.versions import compare

    reference = daemon_version or JUNON_VERSION
    found = [
        {"ideVersion": name, "version": version}
        for name, _ in installed_ides()
        if (version := installed_version(name)) is not None
    ]
    if not found:
        return None
    verdict = compare(reference, found, consumer_version=JUNON_VERSION).as_dict()
    verdict["source"] = "disk"
    if not verdict["agrees"]:
        verdict["summary"] = verdict["summary"].replace("plugin(s)", "installed plugin(s)")
    return verdict


#: How far the daemon's recorded `startedAt` may sit from the kernel's start time for its pid.
#:
#: The daemon writes the file after its process exists, so the difference is positive and small —
#: measured on this machine: +0.160 s for `node packages/cli/dist/bin.js daemon`. Two seconds is
#: the same allowance `dashboard_registry` makes, for the same reason: this is a sanity check
#: against a **recycled pid**, not a precision instrument.
_START_TIME_TOLERANCE_SECONDS = 2.0


def daemon_process_is_gone(discovery: dict[str, Any]) -> bool:
    """Whether the process the discovery file names has stopped, or is now somebody else.

    **The file is a claim, not a fact.** A daemon that dies leaves it behind — the daemon of
    2026-08-25 left one that outlived it by three weeks, and until this function existed the panel
    read that tombstone and announced *"Daemon running, no IDE attached"* over a port that had been
    refusing connections since. `doctor` had the check (`daemon-process: pid-not-running`) and this
    side did not, which is how one question came to have two answers on one machine.

    Unknowable is not the same as gone: a file from before `pid` existed, a `psutil` that was
    stripped out, a process this user may not query — each leaves the claim exactly as trustworthy
    as it was, which is what the port test after it is for.
    """
    pid = discovery.get("pid")
    if not isinstance(pid, int):
        return False
    try:
        import psutil
    except ImportError:  # pragma: no cover - declared in pyproject
        return False
    try:
        process = psutil.Process(pid)
        created = float(process.create_time())
    except psutil.NoSuchProcess:
        return True
    except Exception:  # noqa: BLE001 - psutil raises a family of its own; none of it is an answer
        return False

    started_at = discovery.get("startedAt")
    if not isinstance(started_at, str):
        return False
    try:
        from datetime import datetime

        recorded = datetime.fromisoformat(started_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    # A pid that came round again wears a start time of its own, and it is never the one the daemon
    # wrote. Compared in both directions: a process that started long after the file was written did
    # not write it, and neither did one that started long before.
    return abs(created - recorded) > _START_TIME_TOLERANCE_SECONDS


def _unavailable(status: Status, reason: str) -> dict[str, Any]:
    """The shape every failure answers with — carrying what is still knowable.

    A page that loses the token and the version verdict whenever an IDE is closed is a page whose
    install button stops working exactly when the install would succeed.
    """
    from junon.update_action import SESSION_TOKEN

    return {
        "status": status,
        "reason": reason,
        "installToken": SESSION_TOKEN,
        "versions": _disk_versions(None),
    }


def read_status() -> dict[str, Any]:
    """Reads the daemon's discovery file and reports what it says.

    The discovery file carries an authentication token, so this reads only the fields the panel
    needs and **never returns the token** — a dashboard response is the last place a local
    credential should end up, and it would be one XSS away from leaving the machine.
    """
    path = _discovery_path()
    try:
        info = path.stat()
    except FileNotFoundError:
        return _unavailable("no-daemon", "No IDE Bridge daemon is running.")
    except OSError as error:
        return _unavailable("unreadable", f"The discovery file could not be read: {error.strerror}.")

    # The daemon writes this 0600 for a reason. If the permissions have widened, something else has
    # been at it, and reading a token-bearing file in that state is not something to do quietly.
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        return _unavailable(
            "unreadable",
            "The discovery file is readable by other users; refusing to read it.",
        )

    try:
        discovery = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return _unavailable("unreadable", f"The discovery file is not valid JSON: {error}.")

    endpoint = discovery.get("endpoint")
    if not isinstance(endpoint, str):
        return _unavailable("unreadable", "The discovery file carries no endpoint.")

    base = {
        "endpoint": endpoint,
        "protocolVersion": discovery.get("protocolVersion"),
    }

    # Before anything is claimed about a daemon: is the one this file describes still there?
    if daemon_process_is_gone(discovery):
        return {
            **base,
            **_unavailable(
                "no-daemon",
                f"No daemon is running. The discovery file still describes pid "
                f"{discovery.get('pid')}, started {discovery.get('startedAt')}, which is gone — a "
                "daemon that stops leaves the file behind. Start one with "
                "`node packages/cli/dist/bin.js daemon`, then relink the IDE from its IDE Bridge "
                "tool window.",
            ),
        }

    # Reading the file proves a daemon was started, not that an IDE is attached — and the panel says
    # "connected". Until 2026-08-11 this returned `no-adapter` unconditionally, which was a guess
    # that happened to be right whenever no IDE was open and wrong the rest of the time. Asking is
    # cheap: one connection, one call, and the answer is the daemon's rather than ours.
    from junon.client import Discovery, IdeBridgeClient, IdeBridgeError
    from junon.versions import compare

    token = discovery.get("token")
    if not isinstance(token, str):
        return {**base, **_unavailable("unreadable", "The discovery file carries no token.")}

    client = IdeBridgeClient(
        Discovery(
            endpoint=endpoint,
            token=token,
            protocol_version=str(discovery.get("protocolVersion", "")),
        ),
        timeout_seconds=PANEL_TIMEOUT_SECONDS,
    )
    # Asked here rather than in the connected branch below, because the branches that matter most
    # for this answer are the ones where no IDE is attached: nothing else in the product can see the
    # daemon's version then, and a daemon left running across an update is exactly what goes stale.
    if version := _ask_daemon_version(client):
        base["daemonVersion"] = version

    try:
        workspaces = client.call("workspace/list", {}).get("workspaces", [])
    except IdeBridgeError as error:
        # Its process is alive — checked above — and its endpoint does not answer. That is its own
        # state, not "no IDE attached": the panel used to say a daemon was running and unreachable
        # in the same breath, which reads as a broken dashboard rather than as a stopped daemon.
        return {
            **base,
            "status": "daemon-unreachable",
            "reason": f"The daemon's process is alive but its endpoint did not answer: {error}",
            "adapter": None,
            # Both of these mean every IDE is closed — which is the state the install
            # button can act in, so the page must still get its token and a verdict.
            "installToken": _install_token(),
            "versions": _disk_versions(base.get("daemonVersion")),
        }

    if not workspaces:
        return {
            **base,
            "status": "no-adapter",
            "reason": "The daemon is running; no IDE has a workspace open.",
            "adapter": None,
            # Both of these mean every IDE is closed — which is the state the install
            # button can act in, so the page must still get its token and a verdict.
            "installToken": _install_token(),
            "versions": _disk_versions(base.get("daemonVersion")),
        }

    # The panel used to show only an adapter id, which tells a reader nothing they can act on. The
    # daemon knows which IDE it is, which build, and which plugin version — all of it reachable by a
    # consumer session, measured rather than assumed. `ideVersion` is passed through as the IDE
    # gives it (`IC-252.23892.409`); turning a build number into a marketing name would be a table
    # this code has no business inventing.
    adapters_by_id: dict[str, dict[str, Any]] = {}
    all_adapters: list[dict[str, Any]] = []
    try:
        for adapter in client.call("bridge/listAdapters", {}).get("adapters", []):
            adapters_by_id[str(adapter.get("adapterId"))] = adapter
            all_adapters.append(adapter)
    except IdeBridgeError:
        # Non-fatal: the panel is still worth showing without the IDE's name on it.
        adapters_by_id = {}
        all_adapters = []

    adapter_id = str(workspaces[0].get("adapterId", ""))
    # Whether the halves of this installation are the same release. Nothing else can tell the
    # person looking at this page: an IDE updates its plugin without knowing a daemon exists, and
    # `pipx` updates JUNON without knowing either.
    versions: dict[str, Any] | None = None
    daemon_version = base.get("daemonVersion")
    if all_adapters and daemon_version:
        from junon.client import JUNON_VERSION

        versions = compare(daemon_version, all_adapters, consumer_version=JUNON_VERSION).as_dict()

    adapter = adapters_by_id.get(adapter_id, {})

    return {
        **base,
        "status": "connected",
        "reason": None,
        # Read by the page so it can prove a click came from here. A cross-site request cannot
        # read this response, which is what makes the header unforgeable.
        "installToken": _install_token(),
        "versions": versions,
        "adapter": {
            "adapterId": adapter_id,
            "ideKind": adapter.get("ideKind"),
            "ideVersion": adapter.get("ideVersion"),
            "pluginName": adapter.get("name"),
            "pluginVersion": adapter.get("version"),
            "capabilityCount": len(adapter.get("capabilities", {})),
        },
        "workspaces": [
            {
                "workspaceId": workspace.get("workspaceId"),
                "name": workspace.get("name"),
                "roots": [root.get("uri") for root in workspace.get("roots", [])],
                "trust": workspace.get("trust"),
            }
            for workspace in workspaces
        ],
    }

def _ask_daemon_version(client: Any) -> str:
    """The running daemon's own version, or "" when it will not say.

    Never raises: this is an aside on a status call, and a panel that goes blank because a version
    could not be read has thrown away the answer it was actually asked for.
    """
    from junon.client import IdeBridgeError

    try:
        version = client.call("bridge/getStatus", {}).get("daemonVersion")
    except IdeBridgeError:
        return ""
    return version if isinstance(version, str) else ""


def _install_token() -> str:
    """This process's install token. Imported late: the dashboard is optional, the status is not."""
    from junon.update_action import SESSION_TOKEN

    return SESSION_TOKEN
