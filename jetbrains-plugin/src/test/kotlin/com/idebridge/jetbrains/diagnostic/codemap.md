# test/…/diagnostic/

## Responsibility

Tests for turning IntelliJ's highlights into protocol diagnostics: position, severity, the fixes each
problem offers, and what must *not* be invented.

## Design

**Absence is expressed as absence.** A problem with no fixes omits the field rather than sending an
empty list, and no diagnostic code is emitted at all, because the platform assigns none — inventing
one would be a claim about a value that does not exist.

**Two scales, mapped explicitly.** IntelliJ's severity is numeric and open-ended; the protocol's has
four levels. The mapping is stated and tested rather than left to a comparison that happens to work.

**A fix's wording is the IDE's own.** The title is published as the inspection wrote it —
`QuickFixTitleTest` covers the markup the platform wraps some titles in, which is why titles once
reached consumers as HTML.

## Flow

```
DiagnosticMappingTest   highlight → diagnostic at the right position; numeric severity → four
                        levels; offered fixes carry the IDE's wording; no fixes means no field;
                        never a diagnostic code
```

## Integration

The mapping feeds `diagnostics/getSnapshot` and the quick-fix half of `refactor/prepare`; the fix
identifier it publishes is what a consumer names when asking for that fix to be applied.
