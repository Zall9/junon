# test/…/connection/

## Responsibility

Tests for everything between the socket and the method table: reading the discovery file, the
handshake, the RPC engine that serves and calls at once, and the router that maps a method name to a
handler.

## Design

**Scripted frames for the rules, a real daemon for the handshake.** Most files drive the client
against canned input, because that is how a protocol violation is provoked on demand.
`RealDaemonHandshakeTest` spawns the actual daemon and completes a genuine authenticated handshake —
and reports itself *skipped*, loudly, when Node or the built CLI is missing, so a green build never
implies an integration that did not run.

**A failure must cost as little as it truly costs.** `RpcClientServeTest` pins that a handler which
throws costs one request rather than the session, and that a request arriving while one of this
client's own calls is outstanding is still served — an adapter is both caller and callee on one
socket.

**Refusals are read from the file, not assumed.** `DiscoveryReaderTest` refuses a world-readable
token file, a non-loopback endpoint, and a symlink rather than following it.

## Flow

```
DiscoveryReaderTest             private file, loopback endpoint, no symlinks
HandshakeClientTest             correlation id, role and protocol version all checked
RealDaemonHandshakeTest         the real thing, over loopback, against a spawned daemon
RpcClientServeTest              inbound requests answered; an unhandled method is a missing
                                capability; a throwing handler does not end the session
AdapterRouterTest               the method table
SearchRefusalTest               a search that cannot look refuses retryably instead of answering
                                emptily
TransportSendSerialisationTest  eight threads, no two sends in flight at once
```

## Integration

The daemon-backed tests need `pnpm -r build` first; they say so in their skip message.
