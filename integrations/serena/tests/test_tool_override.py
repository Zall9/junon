"""Proves that replacing a tool's ``apply`` is what Serena actually calls.

This is the riskiest assumption of the whole tool strategy. Registering *new* tools uses
``tool_packages``, a list upstream clearly intends to be extended. Replacing an *existing* tool's
behaviour does not have a designed seam — we assign over a class attribute — so it is worth proving
rather than believing.

Naming our own classes after Serena's is not an option: tool names are derived from class names, and
a duplicate raises at registry construction, which would take the whole agent down rather than just
our tools. Overriding the method keeps the name, the registration and the enabling rules exactly as
upstream defines them, and changes only what runs.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def restore_find_symbol_apply():
    """Puts the real implementation back, so one test cannot silently break the next."""
    from serena.tools.symbol_tools import FindSymbolTool

    original = FindSymbolTool.__dict__["apply"]
    yield
    setattr(FindSymbolTool, "apply", original)


class TestOverrideMechanism:
    def test_the_tool_name_comes_from_the_class_name(self) -> None:
        """Which is why we cannot simply define our own class with the same name."""
        from serena.tools.symbol_tools import FindSymbolTool

        assert FindSymbolTool.get_name_from_cls() == "find_symbol"

    def test_replacing_apply_changes_what_the_tool_runs(self, restore_find_symbol_apply) -> None:
        from serena.tools.symbol_tools import FindSymbolTool

        sentinel = "answered by IDE Bridge"

        def replacement(self, *args, **kwargs) -> str:  # noqa: ANN001, ANN002, ANN003
            return sentinel

        setattr(FindSymbolTool, "apply", replacement)

        # `get_apply_fn` is how the agent reaches a tool's implementation, so this is the call path
        # that matters — not merely the attribute we just set.
        instance = FindSymbolTool.__new__(FindSymbolTool)
        assert instance.get_apply_fn()() == sentinel

    def test_the_tool_stays_registered_after_the_override(self, restore_find_symbol_apply) -> None:
        """The registry only accepts classes that define ``apply`` in their own ``__dict__``.

        Assigning the attribute keeps that true. Deleting it, or moving the implementation to a
        mixin, would quietly drop the tool from the registry — the tool would not fail, it would
        cease to exist.
        """
        from serena.tools.symbol_tools import FindSymbolTool

        def replacement(self, *args, **kwargs) -> str:  # noqa: ANN001, ANN002, ANN003
            return ""

        setattr(FindSymbolTool, "apply", replacement)

        assert "apply" in FindSymbolTool.__dict__

    def test_restoring_leaves_the_original_in_place(self, restore_find_symbol_apply) -> None:
        """Our override must be reversible, because the seam tests and the agent share a process."""
        from serena.tools.symbol_tools import FindSymbolTool

        original = FindSymbolTool.__dict__["apply"]
        setattr(FindSymbolTool, "apply", lambda self: "")
        setattr(FindSymbolTool, "apply", original)

        assert FindSymbolTool.__dict__["apply"] is original


class TestOverrideTargetsExist:
    """The tools we intend to serve through IDE Bridge, pinned by name.

    A rename upstream turns an override into a no-op: the new tool keeps working, ours is simply
    never reached, and nothing anywhere says so. These assertions are the only thing that would
    notice.
    """

    @pytest.mark.parametrize(
        ("module_name", "class_name", "tool_name"),
        [
            ("serena.tools.symbol_tools", "FindSymbolTool", "find_symbol"),
            ("serena.tools.symbol_tools", "GetSymbolsOverviewTool", "get_symbols_overview"),
            ("serena.tools.symbol_tools", "FindReferencingSymbolsTool", "find_referencing_symbols"),
        ],
    )
    def test_the_tool_we_override_still_exists_under_that_name(
        self, module_name: str, class_name: str, tool_name: str
    ) -> None:
        module = __import__(module_name, fromlist=[class_name])
        tool_class = getattr(module, class_name)

        assert "apply" in tool_class.__dict__, f"{class_name} no longer defines apply concretely"
        assert tool_class.get_name_from_cls() == tool_name
