"""Where a shared JUNON instance and the sessions using it announce themselves to each other.

One instance per project root, shared by every session on that project
(``docs/SHARED_JUNON_PLAN.md``). Two parties have to find each other with no process in between: a
session starting up must learn whether an instance for its root already answers, and on which port;
an instance must learn whether anyone still uses it, so it can stop when nobody does. Both questions
are answered by files, one per process, the way ``dashboard_registry`` already answers "which
dashboards are running" — and with the same liveness rule, because the failure it guards against is
the same: **a pid alone does not identify a process** (ADR-0040). An entry outlives a crash, and a
pid comes round again; an entry is trusted only while the process holding its pid started when the
entry says it did.

Two directories under one root:

    <dir>/instances/<pid>.json   {pid, started_at, root, port}
    <dir>/clients/<pid>.json     {pid, started_at, root, instance_pid}

Nothing here carries a credential. The port answers on loopback to whoever asks, exactly as a
stdio JUNON answers whoever spawned it; the boundary is the machine, as it is today.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

from junon.dashboard_registry import _alive, _is_the_publisher, _start_time

#: Redirects the whole registry, so tests never read or write the real one.
REGISTRY_ENV_VAR = "JUNON_INSTANCES_DIR"

T = TypeVar("T")


def registry_dir() -> Path:
    override = os.environ.get(REGISTRY_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "junon"


@dataclass(frozen=True, slots=True)
class Instance:
    """A shared instance that was serving when it published, and whose process is still that process."""

    pid: int
    root: str
    port: int
    started_at: float | None = None
    #: The JUNON this instance is *running* — the code it imported at start-up, not what is on disk.
    #: `None` for an entry written before instances carried one, which makes it older by definition.
    version: str | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/mcp"


@dataclass(frozen=True, slots=True)
class Client:
    """A session attached to an instance. Its liveness is what keeps the instance alive."""

    pid: int
    root: str
    instance_pid: int
    started_at: float | None = None


def _write(kind: str, pid: int, payload: dict[str, object]) -> Path:
    directory = registry_dir() / kind
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{pid}.json"
    started_at = _start_time(pid)
    if started_at is not None:
        payload["started_at"] = started_at
    # Written whole then renamed, so a reader never sees half an entry.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)
    return path


def _remove(kind: str, pid: int) -> None:
    (registry_dir() / kind / f"{pid}.json").unlink(missing_ok=True)


def _read_live(kind: str, parse: Callable[[dict[str, object]], T], prune: bool) -> list[T]:
    """Every entry whose process is alive and is the process that wrote it, oldest first.

    Anything unreadable, dead, or wearing a recycled pid is dropped — and removed when `prune` is
    set, so the directory does not accumulate the fourteen dead entries the dashboard registry once
    did.
    """
    directory = registry_dir() / kind
    if not directory.is_dir():
        return []
    found: list[T] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            pid = int(payload["pid"])
            recorded_start = payload.get("started_at")
            started_at = None if recorded_start is None else float(recorded_start)
            if not _alive(pid) or not _is_the_publisher(pid, started_at):
                raise ValueError("not the publisher")
            payload["started_at"] = started_at
            found.append(parse(payload))
        except (OSError, ValueError, KeyError, TypeError):
            if prune:
                path.unlink(missing_ok=True)
    return found


def normalise_root(root: str | Path) -> str:
    """The one spelling of a project root that two processes will agree on."""
    return str(Path(root).expanduser().resolve())


# --- instances ---------------------------------------------------------------------------------


def running_version() -> str:
    """The JUNON this process is running, which is not necessarily the one installed on disk."""
    from junon.client import JUNON_VERSION

    return JUNON_VERSION


def version_on_disk() -> str:
    """What the files say **now**, re-read rather than remembered.

    [running_version] is decided once, when the module is imported, and a long-lived process keeps
    that answer for its whole life — which is the whole reason an upgrade leaves instances running
    the previous release. This asks the question again, so a process can notice that it has been
    superseded instead of being told by someone reading a dashboard.

    For an install that is not a checkout the two are always equal: the version comes from metadata
    written at install time, and nothing on disk moves under it.
    """
    from junon.client import _junon_version

    return _junon_version()


def publish_instance(root: str | Path, port: int, pid: int | None = None, version: str | None = None) -> Path:
    process_id = os.getpid() if pid is None else pid
    return _write(
        "instances",
        process_id,
        {
            "pid": process_id,
            "root": normalise_root(root),
            "port": int(port),
            "version": running_version() if version is None else version,
        },
    )


def unpublish_instance(pid: int | None = None) -> None:
    _remove("instances", os.getpid() if pid is None else pid)


def live_instances(prune: bool = True) -> list[Instance]:
    """Every instance running right now, stale ones included — this is the view, not the chooser."""
    return _read_live(
        "instances",
        lambda p: Instance(
            pid=int(p["pid"]),
            root=str(p["root"]),
            port=int(p["port"]),
            started_at=p.get("started_at"),  # type: ignore[arg-type]
            version=p.get("version"),  # type: ignore[arg-type]
        ),
        prune,
    )


def instance_for(root: str | Path) -> Instance | None:
    """The live instance a session may attach to for this root, or `None`.

    **Running the same JUNON is part of matching the root.** An instance holds the code it imported
    at start-up, and it outlives the sessions that started it on purpose — so after an upgrade the
    machine has instances running the previous release, and a session that attached to one would run
    it too. On 2026-09-15 that turned the version card's own advice into a loop: it said *restart the
    host and the session will pick up the current one*, while the restarted host reattached to the
    same superseded instance and the card said the same thing again.

    A superseded instance is left running rather than killed — the sessions already on it are using
    it, and it exits on its own once they are gone. It simply stops being offered to new ones. An
    entry with no version was written before this field existed, which makes it older by definition.

    **Two versions are legitimate, not one: the JUNON this process runs, and the one installed now** —
    the installed one first. Offering only the first made a relay started before an upgrade — the old
    JUNON in memory, the new one on disk — launch an instance, which imports the new code, and then
    refuse it: it waited out the start timeout and launched another, one every 120 s. Measured on
    2026-09-25: thirteen instances of 0.3.13 on one project for a relay holding 0.3.12, none
    attached, each opening a dashboard tab. "Newer is fine" would have been the wrong repair: after a
    rollback it hands a new session the release that was just rolled away from. The disk says which
    release is wanted, whichever way it moved.
    """
    wanted = normalise_root(root)
    live = [i for i in live_instances() if i.root == wanted]
    for version in dict.fromkeys((version_on_disk(), running_version())):
        matches = [i for i in live if i.version == version]
        if matches:
            return matches[-1]
    return None


def instance_with_pid(root: str | Path, pid: int) -> Instance | None:
    """The live instance for this root with this pid, whatever JUNON it runs.

    For a relay that has just launched one: it runs the code on disk, which is exactly what the relay
    asked for when it started it, so its version is not a question.
    """
    wanted = normalise_root(root)
    return next((i for i in live_instances() if i.root == wanted and i.pid == pid), None)


def stop_free(
    kill: Callable[[int, int], None] | None = None,
    including_busy: bool = False,
    except_pid: int | None = None,
) -> tuple[list[Instance], list[Instance]]:
    """Stops instances. Returns what was stopped, and what was left running.

    The answer to "how do I get everything onto the current code". Quitting the agent host does not
    do it: a host's stdio children die with it — measured, one second after the pipe closes — but a
    shared instance is re-parented to launchd on purpose, so that it can outlive the session that
    started it. Nothing was left to end one on demand except waiting out its idle period.

    `including_busy` stops the ones with sessions on them too, which became a reasonable thing to
    offer in 0.3.7: a relay now follows its instance when it is replaced, so those sessions
    reconnect to a fresh one on their next call instead of being finished. It is not the default,
    because a call *in flight* at that moment is reported as unknown rather than retried — a write
    must not be applied twice — so this trades a possible interrupted call for an immediate
    upgrade, and that is the caller's trade to make, not this function's.
    """
    import signal

    send = kill if kill is not None else os.kill
    stopped: list[Instance] = []
    kept: list[Instance] = []
    for instance in live_instances():
        if except_pid is not None and instance.pid == except_pid:
            # The caller is running inside this one. Measured on 2026-09-16, by pressing the button:
            # the dashboard's own instance was stopped mid-request, so the answer never reached the
            # browser — and the rest of the sequence ran in a dying process, which is how a machine
            # ended up with no daemon at all. Whatever is asking keeps the ground it stands on.
            kept.append(instance)
            continue
        if live_clients(instance_pid=instance.pid) and not including_busy:
            kept.append(instance)
            continue
        try:
            send(instance.pid, signal.SIGTERM)
        except ProcessLookupError:
            # Gone between the listing and now — an idle exit that beat us to it, which is the
            # outcome this was asking for. Not reported as stopped: it was not this that did it.
            continue
        stopped.append(instance)
    return stopped, kept


def stop_report(stopped: list[Instance], kept: list[Instance]) -> str:
    """What `--stop` says, in the same voice as the listing."""
    if not stopped and not kept:
        return "No shared JUNON instance is running on this machine; there was nothing to stop."
    lines: list[str] = []
    if stopped:
        lines.append(f"Stopped {len(stopped)} instance(s):")
        for i in stopped:
            lines.append(f"  - {i.root}  pid {i.pid}, JUNON {i.version or 'unknown'}")
        lines.append("  The next session in those projects starts a fresh one on the installed JUNON.")
    if kept:
        lines.append("Left running, because a session is attached:")
        for i in kept:
            lines.append(
                f"  - {i.root}  pid {i.pid}, {len(live_clients(instance_pid=i.pid))} session(s)"
            )
        lines.append(
            "  Add --all to stop these too: since 0.3.7 their sessions reattach to a fresh instance "
            "on their next call. A call in flight at that moment is reported as unknown rather than "
            "retried, which is the only cost."
        )
    return "\n".join(lines)


def superseded_instances(root: str | Path | None = None) -> list[Instance]:
    """Live instances running a JUNON that is no longer the installed one."""
    current = running_version()
    wanted = None if root is None else normalise_root(root)
    return [
        i for i in live_instances()
        if i.version != current and (wanted is None or i.root == wanted)
    ]


# --- clients -----------------------------------------------------------------------------------


def publish_client(root: str | Path, instance_pid: int, pid: int | None = None) -> Path:
    process_id = os.getpid() if pid is None else pid
    return _write(
        "clients",
        process_id,
        {"pid": process_id, "root": normalise_root(root), "instance_pid": int(instance_pid)},
    )


def unpublish_client(pid: int | None = None) -> None:
    _remove("clients", os.getpid() if pid is None else pid)


def live_clients(instance_pid: int | None = None, prune: bool = True) -> list[Client]:
    """Sessions still attached — to one instance if `instance_pid` is given, else to any."""
    clients = _read_live(
        "clients",
        lambda p: Client(
            pid=int(p["pid"]),
            root=str(p["root"]),
            instance_pid=int(p["instance_pid"]),
            started_at=p.get("started_at"),  # type: ignore[arg-type]
        ),
        prune,
    )
    if instance_pid is None:
        return clients
    return [c for c in clients if c.instance_pid == instance_pid]


# --- what a person or an agent is shown ----------------------------------------------------------


def describe(now: float | None = None) -> list[dict[str, object]]:
    """Every live instance with the sessions on it, oldest first — the one view every surface shows.

    `ide_status`, the dashboard and `junon instances` all call this rather than reading the files
    themselves, so the liveness rule has one implementation. Reading prunes: an entry whose process
    is gone disappears from the directory the moment anyone looks.
    """
    import time

    current = time.time() if now is None else now
    clients = live_clients()
    installed = running_version()
    described: list[dict[str, object]] = []
    for instance in live_instances():
        attached = [c for c in clients if c.instance_pid == instance.pid]
        described.append(
            {
                "pid": instance.pid,
                "root": instance.root,
                "port": instance.port,
                "url": instance.url,
                "uptime_seconds": None if instance.started_at is None else max(0, int(current - instance.started_at)),
                "clients": [c.pid for c in attached],
                "this_process": instance.pid == os.getpid(),
                "version": instance.version,
                # Said out loud, because two instances on one root is otherwise a puzzle rather
                # than the ordinary aftermath of an upgrade.
                "superseded": instance.version != installed,
            }
        )
    return described


def describe_text(described: list[dict[str, object]] | None = None) -> str:
    """The same, as lines. Empty is said in words: an absent list reads like a broken reader."""
    described = describe() if described is None else described
    if not described:
        return "No shared JUNON instance is running on this machine."
    lines = [f"{len(described)} shared JUNON instance(s) on this machine:"]
    for entry in described:
        uptime = entry["uptime_seconds"]
        age = "" if uptime is None else f", up {int(uptime) // 60} min"
        me = " (this one is answering you)" if entry["this_process"] else ""
        clients = entry["clients"]
        sessions = f"{len(clients)} session(s) attached" if clients else "no session attached — it will exit when idle"  # type: ignore[arg-type]
        lines.append(f"  - {entry['root']}  pid {entry['pid']}, port {entry['port']}{age}: {sessions}{me}")
        if entry["superseded"]:
            # An entry with no version was written before instances carried one; naming it "None"
            # tells the reader about a missing field rather than about their machine.
            running = f"JUNON {entry['version']}" if entry["version"] else "a JUNON from before this field existed"
            lines.append(
                f"      running {running}, superseded by {running_version()}: "
                "no new session will attach to it, and it exits once the ones on it end."
            )
    return "\n".join(lines)
