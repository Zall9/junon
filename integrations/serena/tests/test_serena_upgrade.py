"""Taking a Serena release, and putting it back when it does not hold.

Serena arrives from a channel that knows nothing about JUNON, and has broken this machine twice that
way. The rules worth pinning are the ones that decide whether a broken upgrade is recoverable:

* an installation that is *already* broken is not upgraded, because the rollback would restore the
  same break and report success;
* a failing check rolls back to the version that was there — read from pipx's own metadata, not
  guessed;
* the rollback is itself checked, and a rollback that does not restore a working installation is the
  loudest thing this script can say rather than a quiet exit 0.

The pipx calls and the smoke test are faked here. What the smoke test *is* — starting the real binary
and proving the port answering belongs to the process it started — is exercised against the live
installation, not from a unit test.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from junon import serena_upgrade as upgrade
from junon.serena_release import SerenaVersions
from junon.serena_upgrade import Step

PROJECT = Path("/project")


class Recorder:
    """Stands in for every subprocess this module runs, and remembers the order."""

    def __init__(self, failing: set[str] | None = None) -> None:
        self.commands: list[list[str]] = []
        self.failing = failing or set()

    def __call__(self, command: list[str], timeout: int = 900) -> tuple[int, str]:
        self.commands.append(command)
        joined = " ".join(command)
        if any(bad in joined for bad in self.failing):
            return 1, "pipx said no"
        return 0, ""

    @property
    def installs(self) -> list[str]:
        return [c[2] for c in self.commands if c[:2] == ["pipx", "install"]]

    @property
    def injections(self) -> list[list[str]]:
        return [c for c in self.commands if c[:2] == ["pipx", "inject"]]


@pytest.fixture
def machine(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()
    monkeypatch.setattr(upgrade, "_run", recorder)
    monkeypatch.setattr(
        upgrade, "check_versions", lambda: SerenaVersions(installed="1.6.1", latest="1.7.0")
    )
    monkeypatch.setattr(
        upgrade, "injected_specs", lambda: [["/checkout", "--editable", "--include-apps"]]
    )
    versions = iter(["1.7.0", "1.6.1"])
    monkeypatch.setattr(upgrade, "installed_version", lambda *_: next(versions, "1.6.1"))
    return recorder


def smoke_returning(*results: bool):
    answers = iter(results)
    return lambda _project: Step("composition", next(answers), "faked")


class TestWhenTheUpgradeHolds:
    def test_nothing_is_rolled_back(self, machine: Recorder, monkeypatch) -> None:
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True, True))

        outcome = upgrade.run(PROJECT)

        assert outcome.ok
        assert machine.installs == ["serena-agent==1.7.0"]
        assert outcome.rolled_back_to == ""

    def test_the_editable_junon_is_put_back_after_the_install(
        self, machine: Recorder, monkeypatch
    ) -> None:
        """`pipx install --force` recreates the venv and drops injections. Without this, a
        successful upgrade would leave an installation with no JUNON in it."""
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True, True))

        upgrade.run(PROJECT)

        assert machine.injections == [
            ["pipx", "inject", "serena-agent", "/checkout", "--editable", "--include-apps"]
        ]


class TestWhenTheUpgradeBreaksIt:
    def test_the_previous_version_is_reinstalled(self, machine: Recorder, monkeypatch) -> None:
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True, False, True))

        outcome = upgrade.run(PROJECT)

        assert machine.installs == ["serena-agent==1.7.0", "serena-agent==1.6.1"]
        assert outcome.rolled_back_to == "1.6.1"
        assert not outcome.stranded

    def test_the_rollback_is_itself_checked(self, machine: Recorder, monkeypatch) -> None:
        """A rollback nobody verified is the same unverified promise this script exists to stop."""
        calls: list[Path] = []

        def smoking(project: Path) -> Step:
            calls.append(project)
            return Step("composition", len(calls) == 1, "faked")

        monkeypatch.setattr(upgrade, "smoke", smoking)

        upgrade.run(PROJECT)

        assert len(calls) == 3, "baseline, after upgrade, after rollback"

    def test_a_rollback_that_does_not_recover_is_shouted_about(
        self, machine: Recorder, monkeypatch
    ) -> None:
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True, False, False))

        outcome = upgrade.run(PROJECT)

        assert outcome.stranded
        assert not outcome.ok


class TestWhatItRefusesToDo:
    def test_an_already_broken_installation_is_not_upgraded(
        self, machine: Recorder, monkeypatch
    ) -> None:
        """Otherwise the upgrade takes the blame for a break it did not cause, and the rollback
        restores an installation that was not working either."""
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(False))

        outcome = upgrade.run(PROJECT)

        assert machine.installs == []
        assert not outcome.ok
        assert "already broken" in outcome.steps[-1].detail

    def test_nothing_happens_when_the_installed_version_is_the_published_one(
        self, machine: Recorder, monkeypatch
    ) -> None:
        monkeypatch.setattr(
            upgrade, "check_versions", lambda: SerenaVersions(installed="1.7.0", latest="1.7.0")
        )
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True))

        outcome = upgrade.run(PROJECT)

        assert machine.installs == []
        assert outcome.ok

    def test_a_dry_run_touches_nothing(self, machine: Recorder, monkeypatch) -> None:
        monkeypatch.setattr(upgrade, "smoke", smoke_returning(True))

        outcome = upgrade.run(PROJECT, dry_run=True)

        assert machine.commands == []
        assert outcome.ok


class TestTheInjectionSpec:
    def test_it_is_read_from_pipx_rather_than_guessed(self, tmp_path: Path, monkeypatch) -> None:
        """The rollback has to restore *this* machine's JUNON — an editable checkout at whatever
        path it really lives — and only pipx knows where that is."""
        metadata = tmp_path / "pipx_metadata.json"
        metadata.write_text(
            json.dumps(
                {
                    "injected_packages": {
                        "ide_bridge": {
                            "package_or_url": "/somewhere/else/integrations/serena",
                            "pip_args": ["--editable"],
                            # Recorded by pipx separately from pip_args. Dropping it re-injects a
                            # working library with no `junon` binary — a rollback that reports
                            # success and leaves nothing to run.
                            "include_apps": True,
                        }
                    }
                }
            )
        )
        monkeypatch.setattr(upgrade, "PIPX_METADATA", metadata)

        assert upgrade.injected_specs() == [
            ["/somewhere/else/integrations/serena", "--editable", "--include-apps"]
        ]

    def test_a_missing_metadata_file_is_not_an_exception(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setattr(upgrade, "PIPX_METADATA", tmp_path / "absent.json")

        assert upgrade.injected_specs() == []

    def test_a_package_injected_without_apps_stays_that_way(self, tmp_path: Path, monkeypatch) -> None:
        """The flag is copied from pipx, not added by policy: a library injected deliberately
        without entry points must not acquire them from a rollback."""
        metadata = tmp_path / "pipx_metadata.json"
        metadata.write_text(
            json.dumps(
                {
                    "injected_packages": {
                        "helper": {"package_or_url": "helper", "pip_args": [], "include_apps": False}
                    }
                }
            )
        )
        monkeypatch.setattr(upgrade, "PIPX_METADATA", metadata)

        assert upgrade.injected_specs() == [["helper"]]

