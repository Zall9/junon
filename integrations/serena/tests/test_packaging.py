"""That an installed JUNON carries its own dashboard.

Every other test here imports from the checkout, which is how this went unnoticed through five
releases: `pipx inject -e` reads the source tree directly, so the dashboard resources were always
present and never once packaged. Built as a wheel, `junon/resources/dashboard/index.html` was absent —
and the consequence is not an import error. `serve_junon_index` falls back to Serena's page when its
assets are missing, so a wheel-installed JUNON runs, answers, registers its tools, and serves the
other dashboard.

So this test builds the artefact and looks inside it. Slower than an assertion about `pyproject.toml`,
and it is the only version that would have caught the bug: the declaration can be right in a dozen
ways that still produce an empty wheel.
"""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[1]

#: What the dashboard cannot render without. `index.html` alone is not enough — the page pulls the
#: emblem and the favicon, and a wheel that carries only the HTML degrades quietly rather than loudly.
REQUIRED = (
    "junon/resources/dashboard/index.html",
    "junon/resources/dashboard/junon-emblem.svg",
    "junon/resources/dashboard/favicon.svg",
)


@pytest.fixture(scope="module")
def wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    destination = tmp_path_factory.mktemp("wheel")
    done = subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation",
         "-w", str(destination), str(PROJECT)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if done.returncode != 0:
        pytest.skip(f"the wheel could not be built here: {done.stderr.strip().splitlines()[-1:]}")
    built = sorted(destination.glob("ide_bridge-*.whl"))
    if not built:
        pytest.skip("pip produced no wheel for this package")
    return built[0]


def test_the_dashboard_ships_with_the_package(wheel: Path) -> None:
    """The failure this pins is silent: no error, just Serena's dashboard instead of JUNON's."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())

    missing = [required for required in REQUIRED if required not in names]

    assert not missing, (
        f"{wheel.name} is missing {missing}. Installed from this wheel, JUNON would run and serve "
        f"Serena's dashboard, because the index view falls back when its assets are absent."
    )


def test_the_modules_ship_too(wheel: Path) -> None:
    """A guard on the guard: a wheel containing only resources would pass the test above."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())

    assert "junon/tools.py" in names
    assert "junon/dashboard.py" in names
