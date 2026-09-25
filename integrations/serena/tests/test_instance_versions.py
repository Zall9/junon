"""An upgraded JUNON must not be handed back the instance running the old one.

A shared instance holds the code it imported at start-up and outlives its sessions deliberately
(thirty idle minutes). So the moment JUNON is upgraded, the machine is running instances of the
previous release — and until this rule existed, a new session attached to one and ran it.

That turned the version card's own advice into a loop, seen on a live dashboard on 2026-09-15:

    this JUNON (0.3.0) is older than the daemon (0.3.1)
    ... restart the host (opencode, Claude Code) and the session will pick up the current one.

The host restarts, `junon attach` finds the instance for that root — the 0.3.0 one, still alive —
reuses it, and the card says exactly the same thing. The advice was written when a session held its
own JUNON, and the shared instance shipped the same day made it false without touching the words.

What is pinned here: matching a root is not enough to be attachable, a superseded instance is left
running rather than killed, and it is *named* wherever instances are listed — two instances on one
root is otherwise a puzzle instead of the ordinary aftermath of an upgrade.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from junon import instances


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


@pytest.fixture
def installed(monkeypatch: pytest.MonkeyPatch):
    """Pins what "the installed JUNON" is, so these tests do not move with the repository."""

    def use(version: str) -> None:
        # Both halves of "installed": what this process runs, and what the disk holds now.
        monkeypatch.setattr(instances, "running_version", lambda: version)
        monkeypatch.setattr(instances, "version_on_disk", lambda: version)

    use("0.3.1")
    return use


class TestAttachingChoosesByVersion:
    def test_an_instance_running_the_installed_junon_is_offered(self, tmp_path: Path, installed) -> None:
        instances.publish_instance(tmp_path, 4242, version="0.3.1")

        found = instances.instance_for(tmp_path)

        assert found is not None and found.port == 4242

    def test_an_instance_running_an_older_junon_is_not(self, tmp_path: Path, installed) -> None:
        """The loop of 2026-09-15: same root, alive, and the wrong code."""
        instances.publish_instance(tmp_path, 4242, version="0.3.0")

        assert instances.instance_for(tmp_path) is None

    def test_an_instance_running_a_newer_junon_is_not_either(self, tmp_path: Path, installed) -> None:
        """A downgrade is as much a mismatch as an upgrade, and guessing which way is safe is how
        two versions end up sharing one process."""
        instances.publish_instance(tmp_path, 4242, version="0.4.0")

        assert instances.instance_for(tmp_path) is None

    def test_an_entry_with_no_version_is_older_by_definition(self, tmp_path: Path, installed) -> None:
        """Written by a JUNON from before instances carried one — which is exactly the release this
        rule exists to supersede."""
        path = instances.publish_instance(tmp_path, 4242, version="0.3.0")
        import json

        payload = json.loads(path.read_text())
        del payload["version"]
        path.write_text(json.dumps(payload))

        assert instances.instance_for(tmp_path) is None

    def test_the_superseded_one_keeps_running_and_is_still_listed(self, tmp_path: Path, installed) -> None:
        """Sessions are using it. It is not offered to new ones; it is not killed either."""
        instances.publish_instance(tmp_path, 4242, version="0.3.0")

        assert instances.instance_for(tmp_path) is None
        assert [i.port for i in instances.live_instances()] == [4242]
        assert [i.port for i in instances.superseded_instances()] == [4242]

    def test_after_an_upgrade_both_are_live_and_only_the_current_is_offered(
        self, tmp_path: Path, installed
    ) -> None:
        """The real shape of the minutes after an upgrade: the old sessions still on the old
        instance, the new ones on a fresh one."""
        instances.publish_instance(tmp_path, 4242, pid=os.getpid(), version="0.3.0")
        # A second entry for the same root, written by the new JUNON. Different pid, so both live.
        import json

        directory = tmp_path / "instances"
        payload = json.loads((directory / f"{os.getpid()}.json").read_text())
        fresh = dict(payload, pid=os.getppid(), port=5555, version="0.3.1")
        fresh["started_at"] = instances._start_time(os.getppid())
        (directory / f"{os.getppid()}.json").write_text(json.dumps(fresh))

        assert {i.port for i in instances.live_instances()} == {4242, 5555}
        assert instances.instance_for(tmp_path).port == 5555


class TestItIsSaidOutLoud:
    def test_the_listing_names_a_superseded_instance_and_what_becomes_of_it(
        self, tmp_path: Path, installed
    ) -> None:
        instances.publish_instance(tmp_path, 4242, version="0.3.0")

        text = instances.describe_text()

        assert "running JUNON 0.3.0, superseded by 0.3.1" in text
        assert "no new session will attach to it" in text
        assert instances.describe()[0]["superseded"] is True

    def test_an_entry_from_before_the_field_is_described_in_words(self, tmp_path: Path, installed) -> None:
        """The three instances live on this machine when the rule shipped had no version at all.
        Printing "running JUNON None" tells a reader about a missing field, not about their machine."""
        import json

        path = instances.publish_instance(tmp_path, 4242, version="0.3.0")
        payload = json.loads(path.read_text())
        del payload["version"]
        path.write_text(json.dumps(payload))

        text = instances.describe_text()

        assert "None" not in text
        assert "a JUNON from before this field existed" in text

    def test_a_current_instance_is_not_flagged(self, tmp_path: Path, installed) -> None:
        instances.publish_instance(tmp_path, 4242, version="0.3.1")

        assert instances.describe()[0]["superseded"] is False
        assert "superseded" not in instances.describe_text()


class TestVersionOnDisk:
    def test_it_is_re_read_rather_than_remembered(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`running_version()` is frozen at import — which is the whole reason a long-lived instance
        cannot notice an upgrade. This one has to ask the files again, every time."""
        answers = iter(["0.3.3", "0.3.4"])
        monkeypatch.setattr("junon.client._junon_version", lambda: next(answers))

        assert instances.version_on_disk() == "0.3.3"
        assert instances.version_on_disk() == "0.3.4"

    def test_it_agrees_with_the_running_one_in_an_unchanged_checkout(self) -> None:
        """The control: if these disagreed on a tree nobody has upgraded, every instance would
        declare itself superseded the moment it started."""
        assert instances.version_on_disk() == instances.running_version()


class TestTheAdviceIsTrueAgain:
    def test_the_card_tells_the_reader_the_old_instance_will_not_be_reused(self) -> None:
        """The words and the behaviour have to be changed together — the words alone are what made
        this a loop in the first place."""
        from junon.versions import CONSUMER_REMEDY

        assert "restart the host" in CONSUMER_REMEDY
        assert "not reused by the new session" in CONSUMER_REMEDY
        assert "junon instances" in CONSUMER_REMEDY
