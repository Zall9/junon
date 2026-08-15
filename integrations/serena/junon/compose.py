"""Applies every customisation to an unmodified Serena, in the one order that works.

This module is the whole architecture in one place. Nothing under ``serena-upstream`` is ever
edited: Serena is imported, a handful of named attributes are rebound to our subclasses, and then it
runs. That is what makes ``pip install -U serena`` conflict-free — there is nothing of ours in their
tree for a merge to fight over.

What we depend on in return is a set of internals upstream never promised to keep. Those are pinned
by ``tests/test_upstream_seams.py``, so an update that moves one fails there, naming it, instead of
producing something inexplicable at runtime.

**Order matters here, and not for style reasons.** :func:`compose` documents each constraint at the
step that carries it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)

# `language_backend: ide_bridge` is NOT provided, though `aenum.extend_enum` does make the member
# resolvable — measured and confirmed. Serena dispatches on `is_lsp()` / `is_jetbrains()` as a binary
# `if/elif` in five places with no third path, so the member takes none of them: no backend is
# initialised, and the symbol retriever asserts `is_lsp()`. It would be a value that parses and then
# does nothing, which is worse in a config file than an absent one. See ADR-0029.

#: Package whose ``Tool`` subclasses should be discovered alongside Serena's own.
JUNON_TOOL_PACKAGE = "junon.tools"


@dataclass(frozen=True, slots=True)
class Composition:
    """What :func:`compose` actually changed, so a caller can log or assert it.

    Returned rather than kept in a global because a silent no-op is the failure mode that matters
    here: every step below can fail in a way that leaves Serena working perfectly and our
    customisation absent.
    """

    tools_package_added: bool
    dashboard_rebound: bool

    @property
    def complete(self) -> bool:
        return self.tools_package_added and self.dashboard_rebound


def _register_tool_package() -> bool:
    """Makes our tools discoverable on the same terms as Serena's own.

    Two steps, and for a while this did only the second.

    ``ToolRegistry`` iterates ``iter_subclasses(Tool)`` and keeps those whose module starts with an
    entry in ``tool_packages``. That list is a **filter, not a loader**: it decides which of the
    already-imported ``Tool`` subclasses to keep, and imports nothing. Naming a package that has
    never been imported therefore contributes exactly nothing — measured, with
    ``tool_packages == ['serena.tools', 'junon.tools']`` and a registry of 29 tools, none of them
    ours. No exception, no log line, just absent. So the module is imported here first, which is
    what puts its classes into ``Tool.__subclasses__()``.

    **Both must happen before anything constructs the registry.** ``ToolRegistry`` is decorated with
    ``@singleton``: the first call builds the instance from whatever was known at that moment and
    caches it forever.
    """
    import junon.tools  # noqa: F401  - imported for the side effect of defining Tool subclasses

    from serena.tools import tools_base

    if JUNON_TOOL_PACKAGE not in tools_base.tool_packages:
        tools_base.tool_packages.append(JUNON_TOOL_PACKAGE)
    return JUNON_TOOL_PACKAGE in tools_base.tool_packages


def _rebind_dashboard() -> bool:
    """Points Serena's agent at the JUNON dashboard.

    The agent constructs ``SerenaDashboardAPI`` by resolving the name on its own module at call
    time, so rebinding that attribute is enough. Our subclass keeps every upstream route working and
    adds its own, which is why the dashboard can stay a single server on a single port instead of a
    second process that can disagree with the agent it describes.
    """
    import serena.agent

    from junon.dashboard import JunonDashboardAPI

    serena.agent.SerenaDashboardAPI = JunonDashboardAPI  # type: ignore[misc]
    return serena.agent.SerenaDashboardAPI is JunonDashboardAPI


def compose() -> Composition:
    """Applies every customisation. Safe to call twice; returns what it changed.

    Raises nothing on its own — each step reports success or failure so the caller can decide. A
    partially composed process is worse than a failed one, because it looks like it worked.
    """
    # 1. Tools first, before any import path can reach the singleton registry.
    tools_package_added = _register_tool_package()

    # 2. The dashboard, needed before the agent builds one.
    dashboard_rebound = _rebind_dashboard()

    composition = Composition(
        tools_package_added=tools_package_added,
        dashboard_rebound=dashboard_rebound,
    )
    if not composition.complete:
        log.warning(
            "JUNON composition is incomplete: %s. Serena will run, but customisations are missing; "
            "run the seam tests to find out which upstream seam moved.",
            composition,
        )
    return composition
