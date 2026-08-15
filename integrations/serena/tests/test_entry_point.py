"""That something actually runs composition.

Every other test in this suite calls `compose()` itself, which proved composition works and hid the
fact that nothing ever called it: no console script, no import hook, no caller outside `tests/`.
Installed next to Serena and started normally, JUNON did nothing at all.

These check the wiring rather than the composition — that the command exists, that it composes
before handing over, and that it hands over rather than reimplementing Serena's CLI.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from unittest.mock import patch

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def test_a_console_script_is_declared() -> None:
    """Without this, the module is importable and unreachable."""
    scripts = tomllib.loads(PYPROJECT.read_text())["project"]["scripts"]

    assert scripts.get("junon") == "junon.__main__:main"


def test_it_composes_before_starting_serena() -> None:
    """The order is the whole point: `ToolRegistry` is a cached singleton, so composing after Serena
    has built it changes nothing and says nothing."""
    calls: list[str] = []

    with (
        patch("junon.compose.compose", side_effect=lambda: calls.append("compose") or _complete()),
        patch("serena.cli.top_level", side_effect=lambda: calls.append("serena")),
    ):
        from junon.__main__ import main

        main()

    assert calls == ["compose", "serena"]


def test_an_incomplete_composition_still_starts_serena() -> None:
    """A JUNON that could not attach is a Serena that still works. Refusing to start would turn a
    cosmetic failure into an outage."""
    started: list[str] = []

    with (
        patch("junon.compose.compose", return_value=_incomplete()),
        patch("serena.cli.top_level", side_effect=lambda: started.append("serena")),
    ):
        from junon.__main__ import main

        main()

    assert started == ["serena"]


def _complete():
    from junon.compose import Composition

    return Composition(tools_package_added=True, dashboard_rebound=True)


def _incomplete():
    from junon.compose import Composition

    return Composition(tools_package_added=False, dashboard_rebound=True)
