"""The frames this client puts on the wire, and how it reads what comes back.

Frame construction and error unwrapping are tested without a socket on purpose: they are pure, and
the parts that are not — connecting, and whether the daemon accepts what we send — are only
honestly provable against a running daemon and a real IDE. That end-to-end run is the one this
project has learned to trust; these tests cover what it would be wasteful to discover there.
"""

from __future__ import annotations

import pytest

from junon.client import Discovery, IdeBridgeClient, RequestFailedError

DISCOVERY = Discovery(endpoint="ws://127.0.0.1:47821", token="t" * 64, protocol_version="0.1.0")


@pytest.fixture
def client() -> IdeBridgeClient:
    return IdeBridgeClient(DISCOVERY)


class TestHandshakeFrame:
    def test_it_asks_for_the_consumer_role(self, client: IdeBridgeClient) -> None:
        """An adapter role would let this client answer requests on an IDE's behalf, which is not
        something a Serena tool should ever be able to do by accident."""
        assert client.handshake_request()["params"]["role"] == "consumer"

    def test_the_version_range_is_exact(self, client: IdeBridgeClient) -> None:
        """A client unsure which version it speaks should be refused, not negotiated down into a
        contract it does not implement."""
        protocol = client.handshake_request()["params"]["protocol"]

        assert protocol["minimum"] == protocol["maximum"] == "0.1.0"

    def test_it_carries_the_token_from_discovery(self, client: IdeBridgeClient) -> None:
        assert client.handshake_request()["params"]["authentication"]["token"] == DISCOVERY.token

    def test_request_ids_are_unique_within_a_session(self, client: IdeBridgeClient) -> None:
        """Reusing an id would let one response be matched to the wrong request — the kind of bug
        that only appears under concurrency and is then very hard to see."""
        ids = {client.request_frame("document/read", {})["id"] for _ in range(50)}

        assert len(ids) == 50


class TestUnwrappingResponses:
    def test_a_result_is_returned(self, client: IdeBridgeClient) -> None:
        assert client.unwrap({"jsonrpc": "2.0", "id": "1", "result": {"text": "x"}}) == {"text": "x"}

    def test_an_error_carries_the_protocol_code(self, client: IdeBridgeClient) -> None:
        """The code is the only part a tool can reason about: `CAPABILITY_UNAVAILABLE` means ask
        something else, `TIMEOUT` means ask again. Flattening it into prose loses that."""
        with pytest.raises(RequestFailedError) as caught:
            client.unwrap(
                {
                    "jsonrpc": "2.0",
                    "id": "1",
                    "error": {
                        "code": -32000,
                        "message": "IDE provider failed",
                        "data": {"code": "CAPABILITY_UNAVAILABLE", "retryable": False},
                    },
                }
            )

        assert caught.value.code == "CAPABILITY_UNAVAILABLE"
        assert caught.value.retryable is False

    def test_a_retryable_error_says_so(self, client: IdeBridgeClient) -> None:
        """A cold IDE answers `TIMEOUT` with `retryable: true`, which was measured on a real
        PyCharm start-up. A tool that treats it as fatal would give up on a working system."""
        with pytest.raises(RequestFailedError) as caught:
            client.unwrap(
                {
                    "jsonrpc": "2.0",
                    "id": "1",
                    "error": {
                        "code": -32000,
                        "message": "Request timed out",
                        "data": {"code": "TIMEOUT", "retryable": True},
                    },
                }
            )

        assert caught.value.retryable is True

    def test_a_refusal_keeps_the_data_that_makes_it_actionable(
        self, client: IdeBridgeClient
    ) -> None:
        """Some refusals are only useful through their details.

        The daemon builds `STALE_DOCUMENT` with the revision the document has *now* — the thing a
        caller re-reads and prepares against — and this client discarded it, leaving a code that
        says "your plan is stale" and nothing about what to do next (ADR-0038).
        """
        with pytest.raises(RequestFailedError) as caught:
            client.unwrap(
                {
                    "jsonrpc": "2.0",
                    "id": "1",
                    "error": {
                        "code": -32000,
                        "message": "Document changed after the plan was prepared",
                        "data": {
                            "code": "STALE_DOCUMENT",
                            "retryable": False,
                            "details": {
                                "documentUri": "file:///workspace/a.ts",
                                "currentRevision": {"contentHash": "sha256:abc"},
                            },
                        },
                    },
                }
            )

        assert caught.value.details["currentRevision"]["contentHash"] == "sha256:abc"

    def test_a_refusal_without_details_has_an_empty_mapping(
        self, client: IdeBridgeClient
    ) -> None:
        """So a caller can read `.details` without guarding every access."""
        with pytest.raises(RequestFailedError) as caught:
            client.unwrap(
                {
                    "jsonrpc": "2.0",
                    "id": "1",
                    "error": {
                        "code": -32000,
                        "message": "no",
                        "data": {"code": "TIMEOUT", "retryable": True},
                    },
                }
            )

        assert caught.value.details == {}

    def test_an_error_without_data_still_raises_something_actionable(
        self, client: IdeBridgeClient
    ) -> None:
        with pytest.raises(RequestFailedError) as caught:
            client.unwrap({"jsonrpc": "2.0", "id": "1", "error": {"code": -32600, "message": "bad"}})

        assert caught.value.code == "UNKNOWN"

    def test_a_response_with_neither_result_nor_error_is_refused(
        self, client: IdeBridgeClient
    ) -> None:
        """Returning `None` here would push the malformed case into every caller, where it becomes
        an `AttributeError` far from its cause."""
        with pytest.raises(RequestFailedError):
            client.unwrap({"jsonrpc": "2.0", "id": "1"})
