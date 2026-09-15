"""The file that says how to start a daemon — and what must be true before anything runs it.

The daemon is the half nobody owns: the JetBrains plugin only connects, and a daemon that dies stays
dead. Neither the dashboard nor the plugin can invent the command, so the installer — the one program
that is by definition running from a checkout with a built daemon — writes it down for them.

Which makes this a file naming a program that will be executed. It is therefore held to the standard
the discovery file's token already sets: owned by this user, writable by nobody else, and refused out
loud rather than ignored. A plugin that runs a command out of a world-writable file is a local
privilege escalation, and the refusals below are what keep this from becoming one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from junon import daemon_command
from junon.daemon_command import DaemonCommand, Refused, read, record


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "daemon.json"
    monkeypatch.setenv(daemon_command.ENV_VAR, str(target))
    return target


class TestRecording:
    def test_what_is_written_is_what_is_read(self, isolated: Path) -> None:
        record(["/usr/bin/node", "/repo/packages/cli/dist/bin.js", "daemon"], "/repo", "0.3.7")

        found = read()

        assert found == DaemonCommand(
            ("/usr/bin/node", "/repo/packages/cli/dist/bin.js", "daemon"), "/repo", "0.3.7"
        )

    def test_it_is_written_readable_by_nobody_else(self, isolated: Path) -> None:
        """0600 from the moment it exists, not chmod-ed afterwards: the gap between the two is a
        window in which it is world-readable, and this one names a command."""
        record(["node", "bin.js"], "/repo")

        assert oct(isolated.stat().st_mode & 0o777) == "0o600"

    def test_a_rewrite_replaces_it_whole(self, isolated: Path) -> None:
        record(["node", "old.js"], "/old")
        record(["node", "new.js"], "/new", "0.3.8")

        assert read() == DaemonCommand(("node", "new.js"), "/new", "0.3.8")
        assert not isolated.with_suffix(".json.tmp").exists()


class TestNothingRecorded:
    def test_no_file_is_no_command_and_no_complaint(self, isolated: Path) -> None:
        """A machine with no checkout is an ordinary state, not an error: `pipx` ships JUNON, not
        the daemon."""
        assert read() is None


class TestRefusals:
    def test_a_file_writable_by_others_is_refused_with_the_fix(self, isolated: Path) -> None:
        record(["node", "bin.js"], "/repo")
        isolated.chmod(0o666)

        with pytest.raises(Refused) as refused:
            read()

        assert "writable by other users" in str(refused.value)
        assert "chmod 600" in str(refused.value)

    def test_a_group_writable_file_is_refused_too(self, isolated: Path) -> None:
        record(["node", "bin.js"], "/repo")
        isolated.chmod(0o620)

        with pytest.raises(Refused):
            read()

    def test_a_readable_but_not_writable_file_is_fine(self, isolated: Path) -> None:
        """The rule is about who can *choose* the command, not who can see it."""
        record(["node", "bin.js"], "/repo")
        isolated.chmod(0o644)

        assert read() is not None

    def test_a_directory_is_refused(self, isolated: Path) -> None:
        isolated.mkdir()

        with pytest.raises(Refused) as refused:
            read()

        assert "not a regular file" in str(refused.value)

    @pytest.mark.parametrize(
        "content", ["{not json", json.dumps({"directory": "/repo"}), json.dumps({"argv": [], "directory": "/repo"})]
    )
    def test_a_damaged_file_is_refused_rather_than_guessed_at(self, isolated: Path, content: str) -> None:
        isolated.write_text(content)
        isolated.chmod(0o600)

        with pytest.raises(Refused):
            read()

    def test_refusing_is_loud_rather_than_silent(self, isolated: Path) -> None:
        """Returning `None` for an untrusted file would read as "no daemon configured", and the
        caller would go on to report a machine with no daemon instead of a file to fix."""
        record(["node", "bin.js"], "/repo")
        isolated.chmod(0o666)

        with pytest.raises(Refused):
            read()
        assert isolated.exists(), "a refusal does not delete the evidence"


class TestOwnership:
    def test_a_file_owned_by_someone_else_is_refused(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Cannot be created on this machine without root, so the ownership check is exercised by
        moving this process rather than the file — the branch is what matters."""
        record(["node", "bin.js"], "/repo")
        monkeypatch.setattr(os, "getuid", lambda: os.stat(isolated).st_uid + 1)

        with pytest.raises(Refused) as refused:
            read()

        assert "owned by uid" in str(refused.value)
