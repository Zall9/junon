"""What no test is allowed to touch: this machine.

Three times in one day a test reached out of its sandbox and changed the machine it was running on.
Once it counted — and then terminated — shared instances belonging to the user's own agent sessions,
because it filtered the process table by repository path instead of reading its own registry. Once it
stopped and restarted the developer's live daemon, turning 0.4 s of tests into 33 s and, on a working
machine, dropping an IDE's connection mid-edit. And once, unnoticed until the file's timestamp gave
it away, a test rewrote `~/.ide-bridge/daemon.json` — the file an IDE reads to decide what program to
execute when it finds no daemon.

None of those were bad luck. They are what happens when a module resolves a path from `$HOME` and a
test forgets to say otherwise, so the default is moved here rather than left to each test's memory:
**every test writes to its own `tmp_path` unless it deliberately says where.** A test that wants the
real resolution overrides these the same way, and says in its own words why.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from junon import daemon_command, instances


@pytest.fixture(autouse=True)
def nothing_outside_this_test(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Points every machine-wide path at this test's own directory.

    `monkeypatch.setenv` here runs before a test's own fixtures, so a file that needs a particular
    location still sets it and wins — this is a floor, not a ceiling.
    """
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path / "junon-registry"))
    monkeypatch.setenv(daemon_command.ENV_VAR, str(tmp_path / "daemon.json"))
