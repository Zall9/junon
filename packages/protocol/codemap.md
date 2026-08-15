# packages/protocol/

## Responsibility

The wire contract, and the only place it is defined. Every message shape, error code, identifier
pattern and bound lives here as a JSON Schema; the TypeScript types are generated from those schemas,
and the runtime validators are compiled from them too.

## Design

**Schemas are the source; types are output.** `src/generated.ts` is written by `scripts/generate-types.ts`
and must never be edited by hand. A shape that exists only in TypeScript does not exist.

**Schemas are read, never compiled.** They are imported with JSON import attributes and validated at
runtime from source. Comparing `dist` and `src` timestamps to detect staleness produces false alarms
for exactly this reason.

**Validation is split by direction**, because the rules differ: `handshake-validation.ts` for the
authenticated opening, `application-validation.ts` for everything routed afterwards, and
`discovery-validation.ts` for the file on disk that has no session at all.

**`workspace-uri.ts` is containment, not string matching.** Whether a URI lies inside a workspace root
decides what an adapter may report and what the daemon will authorise, so it is one implementation
that every package shares.

## Flow

```
schemas/{bridge,common,discovery,error,method,notification,testing}/*.schema.json
   │
   ├─ generate-types.ts ──▶ src/generated.ts ──▶ every package's types
   ├─ ajv ───────────────▶ src/*-validation.ts ──▶ runtime classification
   └─ fixtures/ ─────────▶ tests/ ──▶ proof that the schemas accept and reject what they must
```

`fixtures/languages/` and `fixtures/vectors/` are shared with the Kotlin and Python sides, which
re-declare these shapes by hand: the fixtures are what keeps three hand-written implementations
honest about one contract.

## Integration

Consumed by every other package. Count guards on the method and notification catalogues live in the
tests here, so adding a message is an acknowledged act rather than an absorbed one.
