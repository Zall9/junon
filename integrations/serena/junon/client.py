"""A thin IDEBP client, deliberately thinner than the TypeScript one.

A full client already exists in `@ide-bridge/bridge-client` — reconnection with backoff, session
restoration, cancellation, tombstones, 44 tests. Reimplementing that here would create two
implementations of one protocol, which is the drift ADR-0025 exists to prevent.

This one does not try. It connects, handshakes, and makes request/response calls; it does not
reconnect, restore sessions, or manage inbound adapter requests, because a Serena tool call is a
short synchronous operation that either answers or fails. Anything longer-lived belongs on the
TypeScript side, and the conformance rules are what keep the two honest about response shape.

Every failure is a typed exception carrying something a caller can act on. "No daemon", "no
workspace" and "the adapter refuses this operation" are ordinary states of this system, and a tool
that reports them as an unexplained error teaches its user to distrust the tool.
"""

from __future__ import annotations

import json
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

from junon.ide_bridge_status import DISCOVERY_ENV_VAR, _discovery_path


class IdeBridgeError(Exception):
    """Base class, so a caller can catch everything from this client with one clause."""


class DaemonUnavailableError(IdeBridgeError):
    """No daemon is reachable. Ordinary when no IDE is open; never a defect on its own."""


class DiscoveryUntrustedError(IdeBridgeError):
    """The discovery file exists but is not safe to read.

    Separate from :class:`DaemonUnavailableError` on purpose: a widened-permission token file is a
    security signal, and silently treating it as "no daemon" would hide it.
    """


class RequestFailedError(IdeBridgeError):
    """The daemon or adapter refused. Carries the protocol's own code so it can be acted on."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.retryable = retryable
        # Some refusals are only actionable through their data. `STALE_DOCUMENT` carries the
        # revision the document has *now* — the thing a caller re-reads and prepares against — and
        # this client used to discard it, leaving a code that says "your plan is stale" and nothing
        # about what to do next. The daemon builds that field deliberately; throwing it away here
        # undid the work (ADR-0038).
        self.details: dict[str, Any] = details or {}


@dataclass(frozen=True, slots=True)
class Discovery:
    """What the daemon publishes. The token is held, never returned or logged."""

    endpoint: str
    token: str
    protocol_version: str

    def redacted(self) -> dict[str, str]:
        """Everything except the credential, for logs and dashboard responses."""
        return {"endpoint": self.endpoint, "protocolVersion": self.protocol_version}


def read_discovery(path: Path | None = None) -> Discovery:
    """Reads the daemon's discovery file, refusing it if it is not private.

    The daemon writes this ``0600``. If the permissions have widened, something else has been at it,
    and reading a token out of a world-readable file is not something to do quietly — so this raises
    rather than proceeding. The same check exists in the TypeScript and Kotlin readers; it is the
    kind of guard that only works if every reader has it.
    """
    resolved = path if path is not None else _discovery_path()
    try:
        info = resolved.stat()
    except FileNotFoundError as error:
        raise DaemonUnavailableError(
            f"No IDE Bridge daemon found. Expected its discovery file at {resolved}; "
            f"set {DISCOVERY_ENV_VAR} if it lives elsewhere."
        ) from error
    except OSError as error:
        raise DaemonUnavailableError(f"The discovery file could not be read: {error.strerror}") from error

    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise DiscoveryUntrustedError(
            f"{resolved} is readable by other users and carries an authentication token; "
            "refusing to read it. Remove the file and restart the daemon."
        )

    try:
        payload: dict[str, Any] = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DaemonUnavailableError(f"The discovery file is not valid JSON: {error}") from error

    missing = [key for key in ("endpoint", "token", "protocolVersion") if not payload.get(key)]
    if missing:
        raise DaemonUnavailableError(
            f"The discovery file is missing {', '.join(missing)}; it may be from an older daemon."
        )

    return Discovery(
        endpoint=str(payload["endpoint"]),
        token=str(payload["token"]),
        protocol_version=str(payload["protocolVersion"]),
    )


@dataclass(frozen=True, slots=True)
class Session:
    """An established consumer session. Short-lived by design — see the module docstring."""

    session_id: str
    protocol_version: str


class IdeBridgeClient:
    """One connection, opened per operation.

    Deliberately not a long-lived singleton. A Serena tool call is a short synchronous operation,
    and a persistent connection would need the reconnection, session-restoration and tombstone
    machinery the TypeScript client already owns — reimplementing that here is the drift ADR-0025
    exists to prevent. Connecting per call costs a handshake and buys the absence of a state machine.
    """

    #: Bounded so a wedged adapter surfaces as a timeout rather than a hung agent. Serena's own
    #: ``ide_bridge.request_timeout_seconds`` (TASK.md §21) overrides it.
    DEFAULT_TIMEOUT_SECONDS = 30.0

    #: A ceiling on any single frame. The daemon bounds what it sends, but a client that trusts a
    #: peer to stay within limits has no limit — and this one connects to a socket, not to a
    #: promise. Large enough for a full symbol tree, small enough that a runaway response fails
    #: instead of exhausting memory.
    MAX_FRAME_BYTES = 8 * 1024 * 1024

    def __init__(self, discovery: Discovery, timeout_seconds: float | None = None) -> None:
        self._discovery = discovery
        self._timeout = timeout_seconds if timeout_seconds is not None else self.DEFAULT_TIMEOUT_SECONDS
        self._next_id = 0

    def _request_id(self) -> str:
        self._next_id += 1
        return f"junon-{self._next_id}"

    def handshake_request(self) -> dict[str, Any]:
        """The frame that authenticates this session.

        The version range is exact — ``minimum == maximum == the daemon's own version`` — because a
        client that cannot be sure which version it speaks should be refused rather than negotiated
        down into a contract it does not implement.
        """
        return {
            "jsonrpc": "2.0",
            "id": self._request_id(),
            "method": "bridge/handshake",
            "params": {
                "authentication": {"method": "token", "token": self._discovery.token},
                "role": "consumer",
                "protocol": {
                    "minimum": self._discovery.protocol_version,
                    "maximum": self._discovery.protocol_version,
                },
                "topology": {
                    "hostKind": "local",
                    "environmentKind": "local",
                    "uriSchemes": ["file"],
                },
                "clientInfo": {"name": "junon", "version": "0.1.0"},
            },
        }

    def request_frame(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """A routed application request, ready to send."""
        return {"jsonrpc": "2.0", "id": self._request_id(), "method": method, "params": params}

    @staticmethod
    def unwrap(response: dict[str, Any]) -> dict[str, Any]:
        """Turns a JSON-RPC error into a typed exception carrying the protocol's own code.

        The code is what a caller can act on — ``CAPABILITY_UNAVAILABLE`` means "ask something
        else", ``TIMEOUT`` with ``retryable`` means "ask again". Flattening them into one message
        would discard the only part a tool can reason about, which is how a refusal becomes
        indistinguishable from a defect.
        """
        error = response.get("error")
        if error is None:
            result = response.get("result")
            if not isinstance(result, dict):
                raise RequestFailedError("INVALID_RESPONSE", "The daemon returned no result object.")
            return result

        data = error.get("data") if isinstance(error.get("data"), dict) else {}
        raise RequestFailedError(
            str(data.get("code", "UNKNOWN")),
            str(error.get("message", "The daemon refused the request.")),
            retryable=bool(data.get("retryable", False)),
            details=data.get("details") if isinstance(data.get("details"), dict) else None,
        )

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Connects, authenticates, asks once, and closes.

        The whole exchange lives in this method because the connection has no life beyond it. The
        daemon's endpoint already carries its path — ``ws://127.0.0.1:<port>/rpc`` — so it is used
        exactly as published rather than reassembled here, which is one fewer thing to get wrong.
        """
        try:
            with connect(
                self._discovery.endpoint,
                open_timeout=self._timeout,
                close_timeout=self._timeout,
                max_size=self.MAX_FRAME_BYTES,
            ) as socket:
                self._authenticate(socket)
                return self.unwrap(self._exchange(socket, self.request_frame(method, params)))
        except (OSError, WebSocketException) as error:
            # A refused connection is the ordinary state of this system when no IDE is open, so it
            # is reported as an absent daemon rather than as a failed request. The distinction is
            # what lets a tool say "start your IDE" instead of "something went wrong".
            raise DaemonUnavailableError(
                f"Could not reach the IDE Bridge daemon at {self._discovery.endpoint}: {error}"
            ) from error

    @contextmanager
    def session(self) -> Iterator[Callable[[str, dict[str, Any]], dict[str, Any]]]:
        """One connection for several calls, for the operations that need one.

        Reads are fine call-by-call, and `call` opens a connection per request for exactly that
        reason. Edits are not: a plan carries the `sessionId` that created it, and so does an undo
        token. Measured against a real IDE — `refactor/prepare` then `workspace/applyPlan` succeeds
        inside one connection and is refused `PLAN_NOT_FOUND` across two, and the same holds for
        `workspace/undo`.

        The scope is deliberately one operation's worth of calls rather than a long-lived client:
        the connection is opened, used, and closed by the `with`, so there is still no reconnection
        policy, no session restoration, and no state surviving a failure.
        """
        try:
            with connect(
                self._discovery.endpoint,
                open_timeout=self._timeout,
                close_timeout=self._timeout,
                max_size=self.MAX_FRAME_BYTES,
            ) as socket:
                self._authenticate(socket)

                def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
                    return self.unwrap(self._exchange(socket, self.request_frame(method, params)))

                yield call
        except (OSError, WebSocketException) as error:
            raise DaemonUnavailableError(
                f"Could not reach the IDE Bridge daemon at {self._discovery.endpoint}: {error}"
            ) from error

    def _authenticate(self, socket: Any) -> Session:
        """Performs the handshake, or raises with the daemon's own reason for refusing."""
        result = self.unwrap(self._exchange(socket, self.handshake_request()))
        return Session(
            session_id=str(result["sessionId"]),
            protocol_version=str(result["protocolVersion"]),
        )

    def _exchange(self, socket: Any, frame: dict[str, Any]) -> dict[str, Any]:
        """Sends one frame and returns the response bearing its id.

        Frames that are not the answer are skipped rather than mistaken for one. The daemon may send
        a consumer notifications at any time, and taking the next frame off the socket as "the
        response" would attribute one message's contents to another request — a bug that appears
        only under load and is then very hard to see.
        """
        socket.send(json.dumps(frame))

        while True:
            try:
                raw = socket.recv(timeout=self._timeout)
            except TimeoutError as error:
                raise RequestFailedError(
                    "TIMEOUT",
                    f"The daemon did not answer {frame['method']} within {self._timeout:g}s.",
                    retryable=True,
                ) from error

            try:
                message = json.loads(raw)
            except (TypeError, ValueError) as error:
                raise RequestFailedError(
                    "INVALID_RESPONSE", "The daemon sent something that is not JSON."
                ) from error

            if isinstance(message, dict) and message.get("id") == frame["id"]:
                return message
