"""When the installing is done and only the restart is not, the card must stop asking for an install.

An IDE reports the plugin it loaded at **start-up**, so it keeps naming the old version for as long
as it runs, however current its disk has become. The version card read that as "this plugin is out
of date" and produced the install remedy — quit the IDE, press the button, watch it answer *already
current*, and find the one step that would have fixed it buried at the end of the sentence.

Measured on 2026-09-15: both IDEs carrying 0.3.5 on disk, PhpStorm running 0.3.3, a daemon on 0.3.5,
and a card still saying *Install the current plugin in each IDE named above*. The third card that
day to ask for work nobody needed to do, after the install button's two.

Only the `older` fault is rewritten. A stale daemon and a stale JUNON are different halves with
different remedies, and nothing here knows anything about them.
"""

from __future__ import annotations

from typing import Any

import pytest

from junon import ide_bridge_status
from junon.ide_bridge_status import _restart_rather_than_install, nothing_left_to_install
from junon.versions import REMEDY, RESTART_REMEDY, compare


def verdict(daemon: str = "0.3.5", adapters: list[dict[str, str]] | None = None, consumer: str = "0.3.5") -> dict[str, Any]:
    adapters = adapters if adapters is not None else [{"ideVersion": "PS-253", "version": "0.3.3"}]
    return compare(daemon, adapters, consumer_version=consumer).as_dict()


@pytest.fixture
def machine(monkeypatch: pytest.MonkeyPatch):
    """What the IDEs hold on disk, and what the newest artefact is."""

    def use(on_disk: dict[str, str | None], artefact: str | None = "0.3.5") -> None:
        monkeypatch.setattr(
            ide_bridge_status_update := __import__("junon.update_action", fromlist=["x"]),
            "installed_ides",
            lambda: [(name, None) for name in on_disk],
        )
        monkeypatch.setattr(ide_bridge_status_update, "installed_version", lambda ide: on_disk[ide])
        monkeypatch.setattr(ide_bridge_status_update, "artefact", lambda: "zip" if artefact else None)
        monkeypatch.setattr(ide_bridge_status_update, "artefact_version", lambda path: artefact)

    return use


class TestNothingLeftToInstall:
    def test_every_ide_already_holding_the_artefact_version(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})

        assert nothing_left_to_install() is True

    def test_one_ide_behind_is_enough_to_need_an_install(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.3"})

        assert nothing_left_to_install() is False

    def test_an_ide_with_no_plugin_at_all_needs_one(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": None})

        assert nothing_left_to_install() is False

    @pytest.mark.parametrize("case", [({}, "0.3.5"), ({"GoLand": "0.3.5"}, None)])
    def test_nothing_to_compare_is_not_an_answer(self, machine, case) -> None:
        """No IDE, or no artefact: the caller keeps the advice it had rather than being told the
        best case by a function that could not tell."""
        on_disk, artefact = case
        machine(on_disk, artefact)

        assert nothing_left_to_install() is False


class TestTheRemedyThatIsSwapped:
    def test_a_stale_plugin_with_a_current_disk_asks_only_for_a_restart(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})

        result = _restart_rather_than_install(verdict())

        assert result["remedy"] == RESTART_REMEDY
        assert "nothing to install" in result["remedy"]
        assert "Install the current plugin" not in result["remedy"]

    def test_the_rest_of_the_verdict_is_untouched(self, machine) -> None:
        """Only the advice changes: the fault is real and must keep being reported."""
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})
        before = verdict()

        result = _restart_rather_than_install(before)

        assert result["agrees"] is False
        assert result["older"] == before["older"]
        assert result["summary"] == before["summary"]

    def test_a_stale_plugin_whose_disk_is_also_stale_still_asks_for_an_install(self, machine) -> None:
        """The case the original remedy is right about, and which this must not swallow."""
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.3"})

        assert _restart_rather_than_install(verdict())["remedy"] == REMEDY

    def test_a_verdict_that_agrees_is_left_alone(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})
        agreeing = verdict(adapters=[{"ideVersion": "PS-253", "version": "0.3.5"}])

        assert _restart_rather_than_install(agreeing) == agreeing

    def test_a_stale_daemon_keeps_its_own_remedy(self, machine) -> None:
        """A different half, a different fix — and restarting an IDE would not touch it."""
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})
        stale_daemon = verdict(daemon="0.3.0", adapters=[{"ideVersion": "PS-253", "version": "0.3.5"}], consumer="0.3.5")

        result = _restart_rather_than_install(stale_daemon)

        assert result["remedy"] == stale_daemon["remedy"]
        assert RESTART_REMEDY not in result["remedy"]

    def test_a_stale_junon_keeps_its_own_remedy(self, machine) -> None:
        machine({"GoLand": "0.3.5", "PhpStorm": "0.3.5"})
        stale_consumer = verdict(daemon="0.3.5", adapters=[{"ideVersion": "PS-253", "version": "0.3.3"}], consumer="0.3.0")

        result = _restart_rather_than_install(stale_consumer)

        assert "restart the host" in result["remedy"]
