"""Proves the customisations actually take effect on an unmodified Serena.

The seam tests assert that the places we reach into still have the shape we need. These assert that
reaching into them *works* — which is a different claim, and the one that matters. A seam can be
perfectly intact while our composition silently fails to use it.

Every failure mode here is silent by nature: an enum member that exists but cannot be resolved, a
tool package appended after the registry was built, a dashboard rebind that lands on the wrong name.
None of them raises. All of them leave Serena running and JUNON absent.
"""

from __future__ import annotations

import pytest

from junon.compose import JUNON_TOOL_PACKAGE, compose


@pytest.fixture(scope="module", autouse=True)
def composed() -> None:
    """Composition runs once for this module, as it does once per process in production."""
    compose()


class TestLanguageBackendIsDeliberatelyNotExtended:
    """`language_backend: ide_bridge` is not provided, and that is a decision, not an omission.

    `aenum.extend_enum` does make the member resolvable — that was measured and it worked. What does
    not work is the behaviour behind it: Serena branches on `is_lsp()` / `is_jetbrains()` as a binary
    `if/elif` in five places, so a third member takes none of them. The agent initialises no backend
    and the symbol retriever asserts `is_lsp()`.

    A config value that parses and then does nothing is worse than an absent one, so it was removed.
    This test exists so that reasoning is not quietly reversed by someone who notices the enum is
    extensible — it is; that was never the problem. See ADR-0029.
    """

    def test_we_do_not_add_a_backend_member(self) -> None:
        from serena.config.serena_config import LanguageBackend

        assert {member.name for member in LanguageBackend} == {"LSP", "JETBRAINS"}

    def test_serena_still_rejects_the_value(self) -> None:
        import pytest as _pytest

        from serena.config.serena_config import LanguageBackend

        # Users configure `LSP` and get IDE Bridge behaviour through overridden tools instead.
        with _pytest.raises(ValueError):
            LanguageBackend.from_str("ide_bridge")


class TestToolDiscovery:
    def test_our_package_is_registered_for_discovery(self) -> None:
        from serena.tools import tools_base

        assert JUNON_TOOL_PACKAGE in tools_base.tool_packages

    def test_serenas_own_tools_are_still_discovered(self) -> None:
        """Appending to a shared list is cheap to get wrong — a stray assignment instead of an
        append would leave Serena with no tools at all."""
        from serena.tools import tools_base

        assert "serena.tools" in tools_base.tool_packages


class TestDashboardRebind:
    def test_the_agent_would_construct_the_junon_dashboard(self) -> None:
        import serena.agent

        from junon.dashboard import JunonDashboardAPI

        assert serena.agent.SerenaDashboardAPI is JunonDashboardAPI

    def test_it_is_still_a_serena_dashboard(self) -> None:
        """Replacement, not amputation: every upstream route must keep working, which is only true
        while ours is a subclass rather than a lookalike."""
        from serena.dashboard import SerenaDashboardAPI

        from junon.dashboard import JunonDashboardAPI

        assert issubclass(JunonDashboardAPI, SerenaDashboardAPI)


class TestCompositionReporting:
    def test_it_reports_what_it_changed(self) -> None:
        """A partially composed process is worse than a failed one, because it looks like it
        worked. `compose()` returns its result so a caller can refuse to continue."""
        result = compose()

        assert result.complete
        assert result.tools_package_added
        assert result.dashboard_rebound
