"""Where a running JUNON dashboard announces itself, so the IDE can offer a link to it.

The IDE plugin knows the daemon; it has no way to know Serena's dashboard, whose port is chosen at
start-up from whatever is free. Observed on one machine in one evening: four dashboards on 24282,
24283, 24284 and 24286. So the port cannot be assumed, and a single well-known file would describe
whichever instance wrote last.

Each process therefore publishes its own entry, named for its pid, and a reader keeps the entries
whose process is still alive. Nothing here carries a credential — the dashboard is a local read-only
surface — so the file is plain, unlike the daemon's discovery file.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

#: Beside the daemon's discovery file, because a reader looking for one will look here for the other.
REGISTRY_ENV_VAR = "IDE_BRIDGE_DASHBOARD_DIR"


def registry_dir() -> Path:
    override = os.environ.get(REGISTRY_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "dashboards"


@dataclass(frozen=True, slots=True)
class Dashboard:
    """A dashboard that was running when it published, and whose process still exists."""

    url: str
    pid: int
    project: str | None


def publish(url: str, project: str | None = None, pid: int | None = None) -> Path:
    """Records this process's dashboard, replacing any entry it left behind previously."""
    process_id = os.getpid() if pid is None else pid
    directory = registry_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{process_id}.json"
    path.write_text(
        json.dumps({"url": url, "pid": process_id, "project": project}),
        encoding="utf-8",
    )
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


def read_all(prune: bool = True) -> list[Dashboard]:
    """Every dashboard still running, newest entry last.

    A dashboard that crashed leaves its file behind, and offering a link to a dead port is worse
    than offering none — so liveness is checked rather than assumed, and stale entries are removed
    as they are found.
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
        except (OSError, ValueError, KeyError, TypeError):
            if prune:
                path.unlink(missing_ok=True)
            continue

        if not _alive(pid):
            if prune:
                path.unlink(missing_ok=True)
            continue

        found.append(Dashboard(url=url, pid=pid, project=payload.get("project")))
    return found
