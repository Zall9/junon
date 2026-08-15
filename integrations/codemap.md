# integrations/

## Responsibility

Where IDE Bridge is joined to an agent toolchain that already exists. One integration lives here so
far: `serena/`, which gives a Serena agent the IDE's own answers instead of a text search's.

## Design

**Composition, never a fork.** An integration extends its host at runtime and does not edit it. The
Serena one adds tools by importing them so the host's own registry discovers them, and hands over to
the host's CLI unchanged
([ADR-0029](../docs/adr/0029-serena-is-extended-by-runtime-composition.md)).

**A consumer like any other.** An integration holds no privileged position: it opens an authenticated
loopback connection, reads the discovery file under the same `0600` rule, and is refused exactly as a
CLI would be.

## Flow

```
agent host (Serena)
   └─ junon composes its tools in ──▶ ide_bridge client ──▶ daemon ──▶ IDE
```

## Integration

Nothing in `packages/` depends on this directory. The dependency runs one way: an integration uses
the protocol and the daemon, and neither knows it exists.
