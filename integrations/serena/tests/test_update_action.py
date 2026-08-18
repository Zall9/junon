"""What the install button reports, and why it is not the same question as what it did.

Every case here comes from pressing the real button. The first press reported success for a no-op —
`installPlugins` exits 0 against a running IDE and writes nothing — and the second explained two
outcomes with the wrong causes: it told someone to quit an IDE that was already closed, and sent them
to a terminal to discover a reason the process already knew.
"""

from __future__ import annotations

from junon.update_action import InstallOutcome


def outcome(**kwargs: tuple[str, ...]) -> InstallOutcome:
    base: dict[str, tuple[str, ...]] = {
        "installed": (),
        "unchanged": (),
        "failed": (),
        "running": (),
    }
    base.update(kwargs)
    return InstallOutcome(**base)  # type: ignore[arg-type]


class TestItNamesTheCause:
    def test_a_running_ide_is_told_why_it_was_not_written_to(self) -> None:
        """The measured case: two IDEs running, one closed and already current."""
        step = outcome(
            unchanged=("GoLand",),
            failed=("PhpStorm", "PyCharm"),
            running=("PhpStorm", "PyCharm"),
        ).next_step

        assert "PhpStorm, PyCharm could not be written to because they are running" in step
        assert "quit them and press this again" in step
        assert "GoLand already had the current plugin" in step
        # The old wording sent someone to a terminal for a reason the process already had.
        assert "run the command by hand" not in step

    def test_an_idle_ide_that_was_current_is_not_called_a_failure(self) -> None:
        step = outcome(unchanged=("GoLand", "PyCharm")).next_step

        assert "already had the current plugin" in step
        assert "could not be written to" not in step

    def test_a_running_ide_that_was_updated_is_told_to_restart(self) -> None:
        step = outcome(installed=("PhpStorm",), running=("PhpStorm",)).next_step

        assert "restart it" in step
        assert "read at start-up" in step

    def test_a_closed_ide_is_not_told_to_restart_something(self) -> None:
        """It has nothing to restart, and saying so would read as an unfinished step."""
        step = outcome(installed=("PyCharm",)).next_step

        assert "will load it when you next open it" in step
        assert "restart" not in step.split("Then check it took")[0]


class TestItAlwaysSaysHowToCheck:
    def test_every_outcome_ends_with_the_verification(self) -> None:
        """Installed is not loaded. Without this sentence the button's answer is unfalsifiable."""
        for case in (
            outcome(installed=("PyCharm",)),
            outcome(unchanged=("GoLand",)),
            outcome(failed=("PhpStorm",), running=("PhpStorm",)),
            outcome(),
        ):
            assert "ide_status" in case.next_step
            assert "has not been restarted" in case.next_step

    def test_nothing_at_all_still_answers(self) -> None:
        assert "Nothing to install." in outcome().next_step


class TestOk:
    def test_ok_requires_something_installed_and_nothing_failed(self) -> None:
        assert outcome(installed=("PyCharm",)).ok
        assert not outcome(unchanged=("GoLand",)).ok
        assert not outcome(installed=("PyCharm",), failed=("PhpStorm",)).ok
