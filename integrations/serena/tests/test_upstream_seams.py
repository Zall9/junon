"""The contract between this integration and upstream Serena.

Every customisation here works by **runtime composition**: we never edit a file under
``serena-upstream``, we import Serena and rebind a small number of named attributes to our own
subclasses before starting it. That is what keeps ``pip install -U serena`` conflict-free forever —
there is nothing of ours in their tree to conflict with.

The price is that we depend on internals upstream never promised to keep. That price is only
acceptable if a break is **loud and named**, which is what this file is for. Each test asserts one
seam still has the shape our code needs, so an upstream update fails here — pointing at the seam that
moved — instead of somewhere unrecognisable at runtime three layers away.

If a test in this file fails after an upstream bump, that is the system working. Read the failure,
adapt the corresponding customisation, and move on.
"""

from __future__ import annotations

import enum
import inspect

import pytest


class TestLanguageBackendSeam:
    """``language_backend: ide_bridge`` requires extending a closed enum at runtime.

    ``LanguageBackend`` is a plain :class:`enum.Enum` with two members, and ``from_str`` raises on
    anything it does not recognise. Python enums cannot be subclassed once they have members, so the
    only way to add ours without editing Serena is ``aenum.extend_enum``.

    That works **because** ``from_str`` iterates the enum rather than matching a fixed literal. If it
    ever stops iterating, our member becomes invisible and this seam is gone.
    """

    def test_language_backend_is_an_enum_we_can_extend(self) -> None:
        from serena.config.serena_config import LanguageBackend

        assert issubclass(LanguageBackend, enum.Enum)
        # Extension only helps if lookup is dynamic. A hardcoded if/elif would silently ignore us.
        source = inspect.getsource(LanguageBackend.from_str)
        assert "for backend in LanguageBackend" in source, (
            "from_str no longer iterates the enum, so an extended member would be unreachable"
        )

    def test_the_backends_we_build_on_still_exist(self) -> None:
        from serena.config.serena_config import LanguageBackend

        # We do not replace these; we sit alongside them. Their disappearance would mean upstream
        # reworked the concept and our member's semantics need rethinking, not just renaming.
        assert {member.name for member in LanguageBackend} >= {"LSP", "JETBRAINS"}

    def test_the_backend_choice_is_read_through_one_method(self) -> None:
        from serena.config.serena_config import SerenaConfig

        # Our backend is selected through the same path as any other, so this is where a wrong
        # answer would surface.
        assert callable(SerenaConfig.determine_language_backend)


class TestDashboardSeam:
    """The JUNON dashboard replaces Serena's, in Serena's own server.

    Serving our UI from a second process would be simpler, but it would mean two ports, two
    lifecycles, and a dashboard that can disagree with the agent it describes. Instead we subclass
    ``SerenaDashboardAPI`` and rebind the name the agent constructs, so our routes and our static
    directory are served by the same Flask app — and every upstream route keeps working untouched.
    """

    def test_dashboard_api_is_a_subclassable_class(self) -> None:
        from serena.dashboard import SerenaDashboardAPI

        assert inspect.isclass(SerenaDashboardAPI)
        # We override this to add IDE Bridge routes after upstream's are registered.
        assert hasattr(SerenaDashboardAPI, "_setup_routes")

    def test_the_agent_constructs_the_dashboard_by_module_attribute(self) -> None:
        import serena.agent

        # The rebind point. If the agent stopped resolving this name at call time — importing it
        # into a local, say — assigning to the module attribute would no longer take effect.
        assert hasattr(serena.agent, "SerenaDashboardAPI")
        source = inspect.getsource(serena.agent)
        assert "SerenaDashboardAPI(" in source, "the agent no longer constructs the dashboard by name"

    def test_the_static_directory_is_a_single_constant(self) -> None:
        from serena import constants

        # Our subclass serves its own directory instead. A per-file lookup would need a different
        # override.
        assert isinstance(constants.SERENA_DASHBOARD_DIR, str)

    def test_the_view_functions_we_replace_are_named_as_expected(self) -> None:
        """We swap views by endpoint name, so the names are part of the contract.

        Re-registering the URL rule instead would leave resolution to werkzeug's ordering, which is
        not something to bet a UI on. Replacing the function behind a name is unambiguous — but it
        means an upstream rename must fail here, or the JUNON dashboard would quietly revert to
        Serena's without anything looking wrong.
        """
        import inspect as _inspect

        from serena.dashboard import SerenaDashboardAPI

        source = _inspect.getsource(SerenaDashboardAPI._setup_routes)
        for view_name in ("redirect_to_dashboard", "serve_dashboard", "serve_dashboard_index"):
            assert f"def {view_name}(" in source, (
                f"upstream renamed the {view_name} view; JUNON would silently serve Serena's UI"
            )

    def test_the_dashboard_constructor_signature_we_pass_through(self) -> None:
        from serena.dashboard import SerenaDashboardAPI

        parameters = inspect.signature(SerenaDashboardAPI.__init__).parameters
        # Our subclass forwards these unchanged; a rename breaks construction immediately.
        assert {"memory_log_handler", "tool_names", "agent"} <= set(parameters)


class TestToolRegistrySeam:
    """Our tools are discovered, not registered.

    ``ToolRegistry`` walks the subclasses of ``Tool`` and keeps those whose module starts with an
    entry in ``tool_packages``. Appending our package to that list makes our tools appear exactly as
    upstream's do — same enabling rules, same dashboard listing, no special case.
    """

    def test_tool_packages_is_a_mutable_list(self) -> None:
        from serena.tools import tools_base

        assert isinstance(tools_base.tool_packages, list)
        assert "serena.tools" in tools_base.tool_packages

    def test_the_registry_is_a_cached_singleton_not_a_class(self) -> None:
        """The ordering hazard our composition has to respect.

        ``ToolRegistry`` reads as a class in the source, but ``@singleton`` replaces it with a
        closure that builds the instance on first call and caches it forever. So the registry is
        populated **once**, from whatever ``tool_packages`` contained at that moment.

        Appending our package after the first call would leave our tools silently missing — no
        error, just absent. Our entry point therefore extends ``tool_packages`` before importing
        anything that touches the registry, and this test is here so that constraint is written
        down rather than rediscovered.
        """
        from serena.tools import tools_base

        registry_factory = tools_base.ToolRegistry
        assert not inspect.isclass(registry_factory), (
            "ToolRegistry is a @singleton factory, not a class; if it became a plain class the "
            "ordering constraint below would no longer apply and the entry point can be simplified"
        )
        assert registry_factory() is registry_factory(), "the registry is no longer cached"

    def test_registration_is_by_subclass_discovery(self) -> None:
        from serena.tools import tools_base

        # The source is read through the module rather than the decorated name, which no longer
        # points at the class.
        source = inspect.getsource(tools_base)
        assert "iter_subclasses" in source, "tools are no longer discovered by subclass walk"
        assert "tool_packages" in source, "package filtering changed; our tools may not be picked up"
        # The inclusion predicate: our tools must define `apply` concretely, not inherit it.
        assert '"apply" in c.__dict__' in source


@pytest.mark.parametrize(
    "module_name",
    [
        "serena.agent",
        "serena.dashboard",
        "serena.config.serena_config",
        "serena.tools.tools_base",
        "serena.constants",
    ],
)
def test_the_modules_we_reach_into_are_importable(module_name: str) -> None:
    """A rename or a package move shows up here first, as a plain import error."""
    __import__(module_name)
