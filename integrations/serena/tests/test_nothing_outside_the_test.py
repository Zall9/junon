"""The floor from `conftest.py`, asserted — because it is invisible when it works.

A test that writes the real `~/.ide-bridge` leaves no failure behind: it passes, and the machine is
different afterwards. That is how `daemon.json` came to be rewritten by a test run on 2026-09-21 and
was noticed only because somebody read the file's timestamp. So the guarantee gets a test of its own,
and it is one that fails loudly the day the fixture is removed.
"""

from __future__ import annotations

from pathlib import Path

from junon import daemon_command, instances

REAL_DAEMON_COMMAND = Path.home() / ".ide-bridge" / "daemon.json"


class TestWhereTestsAreAllowedToWrite:
    def test_the_instance_registry_is_not_the_real_one(self, tmp_path: Path) -> None:
        registry = instances.registry_dir()

        assert registry == tmp_path / "junon-registry", registry
        assert Path.home() / ".ide-bridge" not in registry.parents, (
            f"a test would have published instances into the machine's own registry: {registry}"
        )

    def test_the_daemon_command_file_is_not_the_real_one(self, tmp_path: Path) -> None:
        """The one that matters most: an IDE that finds no daemon executes what this file names."""
        recorded = daemon_command.path()

        assert recorded == tmp_path / "daemon.json", recorded
        assert recorded != REAL_DAEMON_COMMAND

    def test_recording_a_command_leaves_the_machine_alone(self, tmp_path: Path) -> None:
        """`apply_release` records unconditionally, which is right — it must simply record here.

        Asserted against the real file rather than only against the path, because the path is what
        was correct in theory the whole time the file was being overwritten.
        """
        before = REAL_DAEMON_COMMAND.stat().st_mtime_ns if REAL_DAEMON_COMMAND.exists() else None

        written = daemon_command.record(["/usr/bin/node", "/somewhere/bin.js", "daemon"], tmp_path, "9.9.9")

        assert written == tmp_path / "daemon.json"
        after = REAL_DAEMON_COMMAND.stat().st_mtime_ns if REAL_DAEMON_COMMAND.exists() else None
        assert after == before, "a test rewrote the machine's own daemon command file"
