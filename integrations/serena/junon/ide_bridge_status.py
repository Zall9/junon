"""What the dashboard's IDE Bridge panel reports.

Deliberately read-only and deliberately shallow: it answers "is an IDE connected, and which", which
is what the panel shows. Anything the agent actually *does* with the bridge goes through the language
backend, not through here — a dashboard that could drive an IDE would be a second, unaudited path to
the same operations.

Every failure is reported as a state with a reason rather than raised. "No daemon running" and "no
IDE open" are ordinary conditions of this system, and a panel that shows an exception for them is
telling the user their dashboard is broken when it is working correctly.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Literal

#: Where the daemon publishes its endpoint and token. Overridable for tests and for the
#: non-default install layouts the CLI supports.
DISCOVERY_ENV_VAR = "IDE_BRIDGE_DISCOVERY_FILE"

Status = Literal["connected", "no-adapter", "no-daemon", "unreadable"]


def _discovery_path() -> Path:
    override = os.environ.get(DISCOVERY_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".ide-bridge" / "discovery.json"


#: Short on purpose. A dashboard panel that hangs is worse than one that says it does not know, and
#: this call happens while a page is rendering.
PANEL_TIMEOUT_SECONDS = 3.0


def _unavailable(status: Status, reason: str) -> dict[str, Any]:
    """A state the panel can render, never an error it has to interpret."""
    return {"status": status, "reason": reason, "adapter": None}


def read_status() -> dict[str, Any]:
    """Reads the daemon's discovery file and reports what it says.

    The discovery file carries an authentication token, so this reads only the fields the panel
    needs and **never returns the token** — a dashboard response is the last place a local
    credential should end up, and it would be one XSS away from leaving the machine.
    """
    path = _discovery_path()
    try:
        info = path.stat()
    except FileNotFoundError:
        return _unavailable("no-daemon", "No IDE Bridge daemon is running.")
    except OSError as error:
        return _unavailable("unreadable", f"The discovery file could not be read: {error.strerror}.")

    # The daemon writes this 0600 for a reason. If the permissions have widened, something else has
    # been at it, and reading a token-bearing file in that state is not something to do quietly.
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        return _unavailable(
            "unreadable",
            "The discovery file is readable by other users; refusing to read it.",
        )

    try:
        discovery = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return _unavailable("unreadable", f"The discovery file is not valid JSON: {error}.")

    endpoint = discovery.get("endpoint")
    if not isinstance(endpoint, str):
        return _unavailable("unreadable", "The discovery file carries no endpoint.")

    base = {
        "endpoint": endpoint,
        "protocolVersion": discovery.get("protocolVersion"),
    }

    # Reading the file proves a daemon was started, not that an IDE is attached — and the panel says
    # "connected". Until 2026-08-11 this returned `no-adapter` unconditionally, which was a guess
    # that happened to be right whenever no IDE was open and wrong the rest of the time. Asking is
    # cheap: one connection, one call, and the answer is the daemon's rather than ours.
    from junon.client import Discovery, IdeBridgeClient, IdeBridgeError

    token = discovery.get("token")
    if not isinstance(token, str):
        return {**base, **_unavailable("unreadable", "The discovery file carries no token.")}

    client = IdeBridgeClient(
        Discovery(
            endpoint=endpoint,
            token=token,
            protocol_version=str(discovery.get("protocolVersion", "")),
        ),
        timeout_seconds=PANEL_TIMEOUT_SECONDS,
    )
    try:
        workspaces = client.call("workspace/list", {}).get("workspaces", [])
    except IdeBridgeError as error:
        return {
            **base,
            "status": "no-adapter",
            "reason": f"The daemon is running but did not answer: {error}",
            "adapter": None,
        }

    if not workspaces:
        return {
            **base,
            "status": "no-adapter",
            "reason": "The daemon is running; no IDE has a workspace open.",
            "adapter": None,
        }

    # The panel used to show only an adapter id, which tells a reader nothing they can act on. The
    # daemon knows which IDE it is, which build, and which plugin version — all of it reachable by a
    # consumer session, measured rather than assumed. `ideVersion` is passed through as the IDE
    # gives it (`IC-252.23892.409`); turning a build number into a marketing name would be a table
    # this code has no business inventing.
    adapters_by_id: dict[str, dict[str, Any]] = {}
    try:
        for adapter in client.call("bridge/listAdapters", {}).get("adapters", []):
            adapters_by_id[str(adapter.get("adapterId"))] = adapter
    except IdeBridgeError:
        # Non-fatal: the panel is still worth showing without the IDE's name on it.
        adapters_by_id = {}

    adapter_id = str(workspaces[0].get("adapterId", ""))
    adapter = adapters_by_id.get(adapter_id, {})

    return {
        **base,
        "status": "connected",
        "reason": None,
        "adapter": {
            "adapterId": adapter_id,
            "ideKind": adapter.get("ideKind"),
            "ideVersion": adapter.get("ideVersion"),
            "pluginName": adapter.get("name"),
            "pluginVersion": adapter.get("version"),
            "capabilityCount": len(adapter.get("capabilities", {})),
        },
        "workspaces": [
            {
                "workspaceId": workspace.get("workspaceId"),
                "name": workspace.get("name"),
                "roots": [root.get("uri") for root in workspace.get("roots", [])],
                "trust": workspace.get("trust"),
            }
            for workspace in workspaces
        ],
    }
