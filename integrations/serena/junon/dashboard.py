"""The JUNON dashboard, served by Serena's own Flask app.

Serving our UI from a second process would have been simpler, but it would mean two ports, two
lifecycles, and a dashboard that can disagree with the agent it claims to describe. So this
subclasses ``SerenaDashboardAPI`` and runs inside it.

Every upstream route is registered untouched by ``super()._setup_routes()``. We then **rebind three
view functions** by endpoint name — the two that serve static files and the root redirect — so the
UI is ours while every API route upstream owns keeps working exactly as it did. Serena's own
dashboard stays reachable at ``/serena-dashboard/`` rather than being taken away, because a fallback
you can open is worth more than a purely theoretical one.

Rebinding by endpoint name rather than re-registering the URL rule is deliberate: two rules for the
same path resolve by werkzeug's ordering, which is not something to bet a UI on. Replacing the
function behind a name is unambiguous, and a rename upstream fails a seam test instead of silently
restoring their dashboard.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flask import Response, redirect, send_from_directory

from serena.constants import SERENA_DASHBOARD_DIR
from serena.dashboard import SerenaDashboardAPI

from junon import dashboard_registry

log = logging.getLogger(__name__)

#: Built JUNON assets. Produced by the TypeScript dashboard build, not hand-written here.
JUNON_DASHBOARD_DIR = str(Path(__file__).parent / "resources" / "dashboard")

#: The upstream view functions we replace, and what each one does.
_REPLACED_ENDPOINTS = {
    "redirect_to_dashboard": "the root redirect",
    "serve_dashboard": "static asset serving",
    "serve_dashboard_index": "the dashboard entry point",
}


class JunonDashboardAPI(SerenaDashboardAPI):
    """Serena's dashboard with the JUNON front end and IDE Bridge routes."""

    def run_in_thread(self) -> tuple[Any, int]:
        """Starts the dashboard, then records where it can be reached.

        The port is only known here: upstream scans upward from its base port for a free one, and on
        a machine already running Serena that is not the base port. The IDE plugin cannot guess it,
        so it is written down — after the server is up, so a recorded URL is one that answers.
        """
        thread, port = super().run_in_thread()
        try:
            dashboard_registry.publish(
                url=f"http://{self._host}:{port}/dashboard/",
                project=getattr(getattr(self._agent, "_active_project", None), "project_name", None),
            )
        except OSError as error:
            # A dashboard nobody can find still works; refusing to start over a bookkeeping file
            # would trade a small loss for a large one.
            log.warning("JUNON could not publish its dashboard address: %s", error)
        return thread, port

    def _setup_routes(self) -> None:
        # Upstream first: every API route it owns is registered exactly as it would be without us.
        super()._setup_routes()

        missing = [name for name in _REPLACED_ENDPOINTS if name not in self._app.view_functions]
        if missing:
            # Reported, not raised. A dashboard showing Serena's UI is a visible, recoverable
            # disappointment; refusing to start the agent over branding is not.
            log.warning(
                "JUNON could not replace %s — upstream renamed these view functions. The Serena "
                "dashboard is being served instead. Run the seam tests to confirm what moved.",
                ", ".join(f"{name} ({_REPLACED_ENDPOINTS[name]})" for name in missing),
            )
        else:
            self._replace_dashboard_views()

        self._setup_junon_routes()

    def _replace_dashboard_views(self) -> None:
        """Swaps the three static-serving views for ours, leaving the URL map untouched."""

        def serve_junon_index() -> Response:
            # Falls back for the same reason assets do, and it matters more here: this view replaces
            # the one upstream used to serve, so without the fallback a missing build turns the
            # dashboard's front door into a 404 — measured, before the front end existed. A page
            # that is not ours beats no page at all.
            if not (Path(JUNON_DASHBOARD_DIR) / "index.html").is_file():
                log.warning(
                    "No JUNON dashboard build at %s; serving Serena's dashboard instead.",
                    JUNON_DASHBOARD_DIR,
                )
                return send_from_directory(SERENA_DASHBOARD_DIR, "index.html")
            return send_from_directory(JUNON_DASHBOARD_DIR, "index.html")

        def serve_junon_asset(filename: str) -> Response:
            # Anything the JUNON bundle does not carry falls back to Serena's assets, so a partial
            # build degrades into a working page rather than a wall of 404s.
            if (Path(JUNON_DASHBOARD_DIR) / filename).is_file():
                return send_from_directory(JUNON_DASHBOARD_DIR, filename)
            return send_from_directory(SERENA_DASHBOARD_DIR, filename)

        def redirect_to_junon() -> Response:
            return redirect("/dashboard/")  # type: ignore[return-value]

        self._app.view_functions["serve_dashboard_index"] = serve_junon_index
        self._app.view_functions["serve_dashboard"] = serve_junon_asset
        self._app.view_functions["redirect_to_dashboard"] = redirect_to_junon

    def _setup_junon_routes(self) -> None:
        """Routes the JUNON UI needs and Serena has no reason to provide.

        Kept under ``/junon/`` so nothing here can ever collide with an upstream route added later.
        """

        @self._app.route("/serena-dashboard/", methods=["GET"])
        def serve_serena_dashboard_index() -> Response:
            """Serena's own dashboard, still reachable. Useful when ours is the thing that broke."""
            return send_from_directory(SERENA_DASHBOARD_DIR, "index.html")

        @self._app.route("/serena-dashboard/<path:filename>", methods=["GET"])
        def serve_serena_dashboard_asset(filename: str) -> Response:
            return send_from_directory(SERENA_DASHBOARD_DIR, filename)

        @self._app.route("/junon/ide-bridge/status", methods=["GET"])
        def get_ide_bridge_status() -> dict[str, Any]:
            """What the IDE Bridge panel shows: which adapter is connected, and whether it answers.

            Reported as *unavailable with a reason* rather than as an error, because "no IDE is
            connected" is an ordinary state of this system, not a failure of the dashboard.
            """
            from junon.ide_bridge_status import read_status

            return read_status()
