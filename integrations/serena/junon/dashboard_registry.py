"""Where a running JUNON dashboard announces itself, so the IDE can offer a link to it.

The IDE plugin knows the daemon; it has no way to know Serena's dashboard, whose port is chosen at
start-up from whatever is free. Observed on one machine in one evening: four dashboards on 24282,
24283, 24284 and 24286. So the port cannot be assumed, and a single well-known file would describe
whichever instance wrote last.

Each process therefore publishes its own entry, named for its pid, and a reader keeps the entries
whose process is still alive. Nothing here carries a credential — the dashboard is a local read-only
surface — so the file is plain, unlike the daemon's discovery file.

**A pid alone does not identify a process.** Pids are reused, and these entries outlive the
processes that wrote them: fourteen were found sitting in `~/.ide-bridge/dashboards/` for three
days, every one of them dead. When the kernel hands one of those numbers to something unrelated, a
pid-only check calls the entry live and the IDE offers a link to a port that is not a dashboard —
the failure this file exists to prevent, since a link to a dead port is worse than no link at all.
So the publishing process's **start time** is recorded beside its pid, and a reader requires both to
match. A pid can come round again; a pid that came round again at the same instant cannot.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

try:
    import psutil
except ImportError:  # pragma: no cover - declared in pyproject; see `_start_time` for the fallback.
    psutil = None  # type: ignore[assignment]

#: Beside the daemon's discovery file, because a reader looking for one will look here for the other.
REGISTRY_ENV_VAR = "IDE_BRIDGE_DASHBOARD_DIR"

#: How far a recorded start time may sit from the live process's before they are two processes.
#:
#: Not zero, because the two readers of this file ask two different kernels' worth of plumbing for
#: the same fact. Measured on macOS: psutil reported 1786899750.370856 and the JVM's
#: `ProcessHandle.info().startInstant()` reported 1786899750370 ms for the same pid — the same
#: value, truncated to milliseconds. Linux derives both from clock ticks since boot plus a boot time
#: known only to the second, so the two can disagree by rather more than that.
#:
#: Two seconds is far above that disagreement and far below anything that could produce a false
#: match: for one, the pid counter would have to wrap the whole way round and land on this number
#: again within two seconds of the original process starting.
_START_TIME_TOLERANCE_SECONDS = 2.0


def registry_dir() -> Path:
    override = os.environ.get(REGISTRY_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "dashboards"


@dataclass(frozen=True, slots=True)
class Dashboard:
    """A dashboard that was running when it published, and whose process is still that process."""

    url: str
    pid: int
    project: str | None
    #: Epoch seconds, or `None` for an entry written before this field existed.
    started_at: float | None = None


def _start_time(pid: int) -> float | None:
    """When this pid's current process started, in epoch seconds, or `None` if it cannot be told.

    `None` means the question could not be answered here, which is not the same as an answer of
    "no". Every caller treats it the way the whole file behaved before the field existed: the pid
    is the only evidence available, so the pid is what gets used.

    `psutil` is a declared dependency, so the `None` path is for environments that stripped it out
    rather than for the ordinary one. It stays a soft failure because `publish` runs inside Serena's
    agent constructor, where a raised exception takes the whole server down with it.
    """
    if psutil is None:
        return None
    try:
        return float(psutil.Process(pid).create_time())
    except Exception:  # noqa: BLE001 - psutil raises a family of its own; none of it is worth a crash
        return None


def publish(url: str, project: str | None = None, pid: int | None = None) -> Path:
    """Records this process's dashboard, replacing any entry it left behind previously."""
    process_id = os.getpid() if pid is None else pid
    directory = registry_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{process_id}.json"
    payload: dict[str, object] = {"url": url, "pid": process_id, "project": project}
    started_at = _start_time(process_id)
    if started_at is not None:
        # Omitted rather than written as null when it cannot be told, so the entry reads exactly
        # like one written before this field existed — which is precisely what it is.
        payload["started_at"] = started_at
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def unpublish(pid: int | None = None) -> None:
    """Removes this process's entry. Best effort: a crash leaves it, which `read_all` handles."""
    process_id = os.getpid() if pid is None else pid
    (registry_dir() / f"{process_id}.json").unlink(missing_ok=True)


def _alive(pid: int) -> bool:
    """Whether a process exists, without signalling it.

    Signal 0 performs the permission and existence checks and delivers nothing, which is exactly the
    question. A process this user may not signal is still a running process, so `PermissionError`
    counts as alive rather than as absent.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _is_the_publisher(pid: int, recorded_start: float | None) -> bool:
    """Whether the process holding this pid is the one that wrote the entry, not an heir to its pid.

    A missing `recorded_start` is accepted: it is an entry from before the field existed, and
    rejecting those would drop the dashboards of every JUNON running at the moment of an upgrade.
    So is a start time that cannot be read, for the reason given in `_start_time`. Both leave this
    entry exactly as trustworthy as it was before — no worse, and no better.
    """
    if recorded_start is None:
        return True
    actual = _start_time(pid)
    if actual is None:
        return True
    return abs(actual - recorded_start) <= _START_TIME_TOLERANCE_SECONDS


def read_all(prune: bool = True) -> list[Dashboard]:
    """Every dashboard still running, newest entry last.

    A dashboard that crashed leaves its file behind, and offering a link to a dead port is worse
    than offering none — so liveness is checked rather than assumed, and stale entries are removed
    as they are found. Liveness means *this* process, not merely some process wearing its pid: an
    entry whose pid has been recycled is as stale as one whose pid is gone, and is dropped the same
    way, because the port behind it now answers for someone else or for nobody.
    """
    directory = registry_dir()
    if not directory.is_dir():
        return []

    found: list[Dashboard] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            pid = int(payload["pid"])
            url = str(payload["url"])
            # A `started_at` that is present but not a number is a damaged entry, not an old one,
            # and `float` raising here is what routes it to the same place as unreadable JSON.
            recorded_start = payload.get("started_at")
            started_at = None if recorded_start is None else float(recorded_start)
        except (OSError, ValueError, KeyError, TypeError):
            if prune:
                path.unlink(missing_ok=True)
            continue

        if not _alive(pid) or not _is_the_publisher(pid, started_at):
            if prune:
                path.unlink(missing_ok=True)
            continue

        found.append(
            Dashboard(url=url, pid=pid, project=payload.get("project"), started_at=started_at)
        )
    return found
