"""That an installed JUNON carries its own dashboard.

Every other test here imports from the checkout, which is how this went unnoticed through five
releases: `pipx inject -e` reads the source tree directly, so the dashboard resources were always
present and never once packaged. Built as a wheel, `junon/resources/dashboard/index.html` was absent —
and the consequence is not an import error. `serve_junon_index` falls back to Serena's page when its
assets are missing, so a wheel-installed JUNON runs, answers, registers its tools, and serves the
other dashboard.

So this test builds the artefact and looks inside it, which is the only form that can be trusted: a
declaration in `pyproject.toml` can be right in a dozen ways that still produce an empty wheel.

What it does **not** prove is that the declaration is what puts the files there. Measured on
2026-08-25 across four builds — declaration present and absent, isolated and not — all four carried
the resources under setuptools 84, while the first build of that evening carried none. The variable is
the setuptools doing the work. The declaration is what stops the outcome depending on whichever one a
user's pip fetches, and the banner in `test_missing_build.py` is what catches the case where the files
are absent anyway.
"""

from __future__ import annotations

import importlib.util
import shutil
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
    """Builds the artefact, or fails.

    It may only skip where there is no build backend at all — a machine that cannot build a wheel
    cannot be asked about one. Everywhere else a build failure is a failure, because the first version
    of this fixture skipped on *any* non-zero exit and therefore sat green through the mutation that
    deleted the packaging declaration it exists to protect.
    """
    if importlib.util.find_spec("setuptools") is None:
        pytest.skip("no setuptools in this environment; nothing here can build a wheel")

    destination = tmp_path_factory.mktemp("wheel")
    # setuptools reuses `build/` and never removes a file from it, so a wheel built after a file left
    # the package still carries it: an exclusion added to pyproject.toml was invisible here until the
    # stale copy was cleared by hand. Generated and git-ignored — nothing of anyone's is in it.
    shutil.rmtree(PROJECT / "build", ignore_errors=True)
    done = subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation",
         "-w", str(destination), str(PROJECT)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert done.returncode == 0, f"the wheel did not build:\n{done.stdout[-2000:]}{done.stderr[-2000:]}"
    built = sorted(destination.glob("ide_bridge-*.whl"))
    assert built, "pip reported success and produced no wheel"
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


#: What a JUNON installed without a checkout needs to keep its agent gates current and to show its
#: release notes. They are links into the repository (`junon/resources/agent-hosts`,
#: `junon/resources/CHANGELOG.md`), so the wheel carries the files themselves, not a second copy.
GATES = (
    "junon/agent_gates.py",
    "junon/resources/agent-hosts/manifest.json",
    "junon/resources/agent-hosts/opencode/junon-first.ts",
    "junon/resources/agent-hosts/claude-code/junon-first-gate",
    "junon/resources/agent-hosts/claude-code/register-junon-gate.py",
    "junon/resources/agent-hosts/junon-usage.py",
    "junon/resources/CHANGELOG.md",
)


def test_the_agent_gates_and_the_changelog_ship(wheel: Path) -> None:
    """Without them, a `pipx`-installed JUNON cannot refresh its gate, and its dashboard cannot say
    what a release changed — both silently, since a missing source reads as "nothing to do"."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())

    assert not [name for name in GATES if name not in names]


def test_without_a_checkout_the_packaged_gates_are_found(wheel: Path, tmp_path: Path) -> None:
    """Loaded from where a wheel puts it, `agent_gates` finds the copy that travelled with it.

    Loaded by path rather than imported: `import junon` would find the editable checkout this suite
    runs from, which is precisely the case this is not about.
    """
    import importlib.util

    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(tmp_path)
    spec = importlib.util.spec_from_file_location("packaged_agent_gates", tmp_path / "junon" / "agent_gates.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve their annotations through sys.modules
    try:
        spec.loader.exec_module(module)
        found = module.source_dir()
    finally:
        sys.modules.pop(spec.name, None)

    assert found == tmp_path / "junon" / "resources" / "agent-hosts"
    assert (found / "manifest.json").is_file()
