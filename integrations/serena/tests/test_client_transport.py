"""The transport, against a real socket.

A mocked socket would prove that this code calls the methods this code calls. These tests run a
websocket server on loopback and speak the protocol back at the client, so what is exercised is the
connect, the handshake, the framing and the close — the parts that actually break.

The server here is a stand-in for the daemon, not a second implementation of it: it answers exactly
what each test needs and nothing more. The real daemon is exercised by the conformance suite.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from websockets.sync.server import ServerConnection, serve

from junon.client import (
    DaemonUnavailableError,
    Discovery,
    IdeBridgeClient,
    RequestFailedError,
)

TOKEN = "t" * 64


@contextmanager
def daemon(
    handler: Callable[[dict[str, Any]], dict[str, Any] | None],
) -> Iterator[tuple[Discovery, list[dict[str, Any]]]]:
    """Runs a loopback server answering with `handler`; yields its discovery and what it received.

    The log is yielded alongside rather than attached to the `Discovery`, which is frozen — as it
    should be, since it holds a credential.
    """
    received: list[dict[str, Any]] = []

    def serve_connection(socket: ServerConnection) -> None:
        try:
            for raw in socket:
                frame = json.loads(raw)
                received.append(frame)
                reply = handler(frame)
                if reply is not None:
                    socket.send(json.dumps(reply))
        except Exception:  # noqa: BLE001 - the client closing mid-test is not a failure
            pass

    with serve(serve_connection, "127.0.0.1", 0) as server:
        port = server.socket.getsockname()[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        discovery = Discovery(
            endpoint=f"ws://127.0.0.1:{port}/rpc",
            token=TOKEN,
            protocol_version="0.1.0",
        )
        yield discovery, received
        server.shutdown()


def accepted_handshake(frame: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": frame["id"],
        "result": {
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "role": "consumer",
            "protocolVersion": "0.1.0",
            "daemonInfo": {"name": "ide-bridge", "version": "0.1.0"},
            "topology": {
                "hostKind": "local",
                "environmentKind": "local",
                "uriSchemes": ["file"],
            },
        },
    }


class TestASuccessfulCall:
    def test_it_handshakes_before_asking(self) -> None:
        """The order is the security property: an unauthenticated request must never be sent."""

        def handler(frame: dict[str, Any]) -> dict[str, Any]:
            if frame["method"] == "bridge/handshake":
                return accepted_handshake(frame)
            return {"jsonrpc": "2.0", "id": frame["id"], "result": {"symbols": []}}

        with daemon(handler) as (discovery, sent):
            IdeBridgeClient(discovery).call("document/getSymbols", {"uri": "file:///a.py"})

        assert [frame["method"] for frame in sent] == ["bridge/handshake", "document/getSymbols"]

    def test_it_returns_the_result_unwrapped(self) -> None:
        def handler(frame: dict[str, Any]) -> dict[str, Any]:
            if frame["method"] == "bridge/handshake":
                return accepted_handshake(frame)
            return {"jsonrpc": "2.0", "id": frame["id"], "result": {"symbols": [{"name": "x"}]}}

        with daemon(handler) as (discovery, sent):
            result = IdeBridgeClient(discovery).call("document/getSymbols", {})

        assert result == {"symbols": [{"name": "x"}]}

    def test_it_sends_the_token_only_in_the_handshake(self) -> None:
        """A token repeated on every frame is a token with more chances to be logged."""

        def handler(frame: dict[str, Any]) -> dict[str, Any]:
            if frame["method"] == "bridge/handshake":
                return accepted_handshake(frame)
            return {"jsonrpc": "2.0", "id": frame["id"], "result": {}}

        with daemon(handler) as (discovery, sent):
            IdeBridgeClient(discovery).call("document/getSymbols", {})

        assert TOKEN in json.dumps(sent[0])
        assert TOKEN not in json.dumps(sent[1])


class TestWhenTheDaemonRefuses:
    def test_a_rejected_handshake_stops_the_call(self) -> None:
        """Authentication failure must not be followed by the request anyway."""

        def handler(frame: dict[str, Any]) -> dict[str, Any]:
            return {
                "jsonrpc": "2.0",
                "id": frame["id"],
                "error": {
                    "code": -32001,
                    "message": "Authentication failed",
                    "data": {"code": "AUTHENTICATION_FAILED", "retryable": False},
                },
            }

        with daemon(handler) as (discovery, sent):
            with pytest.raises(RequestFailedError) as caught:
                IdeBridgeClient(discovery).call("document/getSymbols", {})

        assert caught.value.code == "AUTHENTICATION_FAILED"
        assert [frame["method"] for frame in sent] == ["bridge/handshake"]

    def test_a_refused_method_keeps_its_code(self) -> None:
        def handler(frame: dict[str, Any]) -> dict[str, Any]:
            if frame["method"] == "bridge/handshake":
                return accepted_handshake(frame)
            return {
                "jsonrpc": "2.0",
                "id": frame["id"],
                "error": {
                    "code": -32000,
                    "message": "This adapter does not provide supertypes.",
                    "data": {"code": "CAPABILITY_UNAVAILABLE", "retryable": False},
                },
            }

        with daemon(handler) as (discovery, sent):
            with pytest.raises(RequestFailedError) as caught:
                IdeBridgeClient(discovery).call("symbol/getHierarchy", {})

        assert caught.value.code == "CAPABILITY_UNAVAILABLE"


class TestWhenNothingAnswers:
    def test_a_closed_port_is_an_absent_daemon_not_a_failed_request(self) -> None:
        """No IDE running is the ordinary state of this system, and it must read as such."""
        discovery = Discovery(
            endpoint="ws://127.0.0.1:1/rpc", token=TOKEN, protocol_version="0.1.0"
        )

        with pytest.raises(DaemonUnavailableError):
            IdeBridgeClient(discovery, timeout_seconds=2.0).call("document/getSymbols", {})

    def test_silence_becomes_a_retryable_timeout(self) -> None:
        """A cold IDE answers late rather than never; a tool must be told it may ask again."""

        def handler(frame: dict[str, Any]) -> dict[str, Any] | None:
            return accepted_handshake(frame) if frame["method"] == "bridge/handshake" else None

        with daemon(handler) as (discovery, sent):
            with pytest.raises(RequestFailedError) as caught:
                IdeBridgeClient(discovery, timeout_seconds=1.0).call("document/getSymbols", {})

        assert caught.value.code == "TIMEOUT"
        assert caught.value.retryable is True


class TestFrameCorrelation:
    def test_a_notification_is_not_mistaken_for_the_answer(self) -> None:
        """The daemon may speak unprompted. Taking the next frame as the response would attribute
        one message's contents to another request."""

        def handler(frame: dict[str, Any]) -> dict[str, Any] | None:
            if frame["method"] == "bridge/handshake":
                return accepted_handshake(frame)
            return None  # answered out of band below

        received: list[dict[str, Any]] = []

        def serve_connection(socket: ServerConnection) -> None:
            try:
                for raw in socket:
                    request = json.loads(raw)
                    received.append(request)
                    if request["method"] == "bridge/handshake":
                        socket.send(json.dumps(accepted_handshake(request)))
                        continue
                    # An unrelated notification first, then the real answer.
                    socket.send(
                        json.dumps(
                            {"jsonrpc": "2.0", "method": "workspace/didChange", "params": {}}
                        )
                    )
                    socket.send(
                        json.dumps(
                            {"jsonrpc": "2.0", "id": request["id"], "result": {"symbols": ["real"]}}
                        )
                    )
            except Exception:  # noqa: BLE001
                pass

        with serve(serve_connection, "127.0.0.1", 0) as server:
            port = server.socket.getsockname()[1]
            threading.Thread(target=server.serve_forever, daemon=True).start()
            discovery = Discovery(
                endpoint=f"ws://127.0.0.1:{port}/rpc", token=TOKEN, protocol_version="0.1.0"
            )
            result = IdeBridgeClient(discovery, timeout_seconds=5.0).call("document/getSymbols", {})
            server.shutdown()

        assert result == {"symbols": ["real"]}
