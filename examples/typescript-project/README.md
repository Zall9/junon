# TypeScript Fixture Project — IDE Bridge

> Deterministic fixture for Phase 1 protocol conformance testing.
> Exercise: interface, class/implementation, multi-file references, overloaded signatures, Unicode symbol, rename target.

## Structure

```
typescript-project/
├── tsconfig.json            # Strict TS config (self-contained, no external deps)
├── src/
│   ├── types.ts             # Interface `Shape`, overloaded `createCircle`, Unicode `π`
│   ├── circle.ts            # Class `Circle implements Shape` (implementation)
│   └── index.ts             # Barrel exports + usage site (multi-file references)
└── tests/
    └── circle.test.ts       # Vitest test referencing `Circle`, `createCircle`, `π`
```

## Symbols for IDEBP testing

| Symbol | Kind | File | Purpose |
|--------|------|------|---------|
| `Shape` | Interface | `src/types.ts` | Public contract |
| `Circle` | Class | `src/circle.ts` | Implementation of `Shape`; rename target |
| `createCircle` | Function (overloaded) | `src/types.ts` | Overload signatures (number / string) |
| `π` | Const (Unicode) | `src/types.ts` | Non-ASCII identifier |
| `circumference` | Function | `src/types.ts` | Uses `π`; referenced from `circle.ts` |
| `buildSampleShapes` | Function | `src/index.ts` | Usage site for `Circle` and `createCircle` |

## Expected contract

### Symbol resolution
- `document/getSymbols` on `src/types.ts` must return: `Shape`, `createCircle` (with overloads), `π`, `circumference`, `parseDiameter`.
- `symbol/getDefinition` on `Circle` in `src/index.ts` must resolve to `src/circle.ts`.
- `symbol/getDefinition` on `π` in `src/circle.ts` must resolve to `src/types.ts`.
- `symbol/getReferences` on `Circle` must include `src/circle.ts` (declaration), `src/index.ts` (import + usage), and `tests/circle.test.ts` (import + usage).
- `symbol/getImplementations` on `Shape` must return `Circle`.

### Overloads
- `createCircle` has two overload signatures and one implementation signature.
- IDEBP `document/getSymbols` may report overloads separately or as a single symbol; conformance tests must accept both representations.

### Rename
- Renaming `Circle` → `Circle2` must update: `src/circle.ts` (declaration), `src/index.ts` (import + usage), `tests/circle.test.ts` (import + usage).
- Renaming `π` is language-dependent; TypeScript supports Unicode identifiers so this should work, but adapters may report `AMBIGUOUS_SYMBOL` if they cannot disambiguate.

### Unicode
- `π` is a valid TypeScript identifier (U+03C0). UTF-16 encoding: one code unit.
- The fixture exercises non-ASCII symbol names in document symbols and references.

## Validation

```bash
# Type-check using root toolchain (no install needed)
npx tsc --noEmit --project tsconfig.json

# Or using the monorepo's tsc:
node ../../node_modules/.bin/tsc --noEmit --project tsconfig.json
```

No runtime dependencies. `vitest` is only needed to execute the test file; type-checking does not require it.
