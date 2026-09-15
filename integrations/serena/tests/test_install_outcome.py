"""What the install button says, when it has nothing to do.

Pressed twice in an hour on 2026-09-15, against IDEs that already carried the exact plugin, the card
headed its answer **"Not installed"** — and the second time it also said *"PhpStorm could not be
written to because it is running: quit it and press this again"* about an IDE whose disk was already
current. Two sentences that sent someone to quit an IDE for nothing and read a success as a failure.

Both came from the same shape: the *running* check ran before anyone asked whether there was
anything to write, and `ok` required something to have been installed — so the best possible
outcome, every IDE already current, could not be reported as good.

`test_update_action.py` covers the installing; this covers the not-installing, which is the answer
this button gives most often.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from junon import update_action
from junon.update_action import InstallOutcome, install


def outcome(installed=(), unchanged=(), failed=(), running=()) -> InstallOutcome:
    return InstallOutcome(tuple(installed), tuple(unchanged), tuple(failed), tuple(running))


class _FakeArchive:
    """Stands in for the zip, so the unpack changes what the next read sees and nothing else."""

    def __init__(self, on_extract) -> None:  # noqa: ANN001
        self._on_extract = on_extract

    def __enter__(self) -> _FakeArchive:
        return self

    def __exit__(self, *exception: object) -> None:
        return None

    def extractall(self, *args: object, **kwargs: object) -> None:
        self._on_extract()


class TestTheHeadline:
    @pytest.mark.parametrize(
        "case,expected",
        [
            (outcome(unchanged=["GoLand", "PhpStorm"]), "Already current"),
            (outcome(installed=["GoLand"]), "Installed"),
            (outcome(installed=["GoLand"], unchanged=["PhpStorm"]), "Installed"),
            (outcome(installed=["GoLand"], failed=["PhpStorm"], running=["PhpStorm"]), "Partly installed"),
            (outcome(failed=["PhpStorm"], running=["PhpStorm"]), "Not installed"),
            (outcome(failed=["GoLand"]), "Install failed"),
            (outcome(), "Nothing to install"),
        ],
    )
    def test_each_outcome_is_named_rather_than_reduced_to_a_boolean(
        self, case: InstallOutcome, expected: str
    ) -> None:
        assert case.title == expected

    def test_everything_already_current_is_a_success(self) -> None:
        """The one this got wrong. Nothing to do is the definition of ok, not the absence of it."""
        assert outcome(unchanged=["GoLand", "PhpStorm"]).ok is True

    def test_an_ide_that_still_needs_the_plugin_and_cannot_take_it_is_not(self) -> None:
        assert outcome(failed=["PhpStorm"], running=["PhpStorm"]).ok is False

    def test_a_failure_nobody_can_explain_is_not_either(self) -> None:
        assert outcome(installed=["GoLand"], failed=["PhpStorm"]).ok is False


class TestARunningIdeThatNeedsNothing:
    """The second sentence: quit an IDE to install what it already has."""

    @pytest.fixture
    def machine(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        """One IDE, whose on-disk version and running state the test decides."""

        def use(on_disk: str | None, running: bool) -> None:
            monkeypatch.setattr(update_action, "installed_ides", lambda: [("PhpStorm", tmp_path / "launcher")])
            monkeypatch.setattr(update_action, "installed_version", lambda ide: on_disk)
            monkeypatch.setattr(update_action, "is_running", lambda ide: running)
            monkeypatch.setattr(update_action, "artefact", lambda: tmp_path / "plugin.zip")
            monkeypatch.setattr(update_action, "artefact_version", lambda path: "0.3.2")
            monkeypatch.setattr(
                update_action, "plugins_directory", lambda ide: pytest.fail("nothing should be written")
            )

        return use

    def test_a_running_ide_that_already_has_it_is_left_alone(self, machine) -> None:
        machine(on_disk="0.3.2", running=True)

        result = install()

        assert result.unchanged == ("PhpStorm",)
        assert result.running == () and result.failed == ()
        assert result.ok is True
        assert result.title == "Already current"
        assert "could not be written" not in result.next_step
        assert "already had the current plugin" in result.next_step

    def test_a_closed_ide_that_already_has_it_is_also_left_alone(self, machine) -> None:
        machine(on_disk="0.3.2", running=False)

        assert install().unchanged == ("PhpStorm",)

    def test_a_running_ide_that_needs_it_is_still_reported_as_blocked(self, machine) -> None:
        """The check must not swallow the real case: an open IDE with an older plugin."""
        machine(on_disk="0.3.1", running=True)

        result = install()

        assert result.running == ("PhpStorm",) and result.failed == ("PhpStorm",)
        assert result.ok is False
        assert "quit it and press this again" in result.next_step

    def test_an_ide_that_is_quit_and_then_installed_reports_installed(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The path a click takes, and the one whose answer was wrong on a live machine.

        Pressed on 2026-09-16 with PhpStorm open on 0.3.6: the jar on disk was replaced during that
        very click — its timestamp says so — and the card still headed the answer *Already current*.
        The end state was right and the sentence was not, which is the kind of thing that teaches a
        reader to stop believing the sentence.
        """
        quit_calls: list[str] = []
        running = {"PhpStorm": True}

        def ask_to_quit(ide: str, timeout: float = 45.0) -> bool:
            quit_calls.append(ide)
            running[ide] = False
            return True

        versions = {"PhpStorm": "0.3.6"}
        directory = tmp_path / "plugins"
        directory.mkdir()

        def unpack(*args: Any, **kwargs: Any) -> None:
            versions["PhpStorm"] = "0.3.7"

        monkeypatch.setattr(update_action, "installed_ides", lambda: [("PhpStorm", tmp_path / "launcher")])
        monkeypatch.setattr(update_action, "installed_version", lambda ide: versions[ide])
        monkeypatch.setattr(update_action, "is_running", lambda ide: running[ide])
        monkeypatch.setattr(update_action, "ask_to_quit", ask_to_quit)
        monkeypatch.setattr(update_action, "artefact", lambda: tmp_path / "plugin.zip")
        monkeypatch.setattr(update_action, "artefact_version", lambda path: "0.3.7")
        monkeypatch.setattr(update_action, "plugins_directory", lambda ide: directory)
        monkeypatch.setattr("zipfile.ZipFile", lambda *a, **k: _FakeArchive(unpack))

        result = install(quit_running=True)

        assert quit_calls == ["PhpStorm"], "it must ask the running IDE to quit"
        assert result.installed == ("PhpStorm",), f"got installed={result.installed} unchanged={result.unchanged}"
        assert result.title == "Installed"
        assert result.ok is True

    def test_an_ide_with_no_plugin_at_all_is_not_called_current(self, machine) -> None:
        machine(on_disk=None, running=True)

        assert install().unchanged == ()


class TestTheArtefactVersionIsRead:
    def test_it_comes_from_the_descriptor_inside_the_zip(self) -> None:
        """Compared against `installed_version`, which reads `plugin.xml`, so this must read the
        same thing — a filename is written by the build and agrees with it only nearly always."""
        from junon.update_action import artefact, artefact_version

        zip_path = artefact()
        if zip_path is None:
            pytest.skip("no artefact in this checkout")

        version = artefact_version(zip_path)

        assert version is not None
        assert version in zip_path.name, "the descriptor and the filename disagree about the version"

    def test_no_artefact_is_no_version_rather_than_a_guess(self) -> None:
        from junon.update_action import artefact_version

        assert artefact_version(None) is None
