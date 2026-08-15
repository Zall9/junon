# Project conventions

- Public contracts: schema first; add fixtures and compatibility tests for every change. Breaking wire changes require protocol-version decision plus ADR.
- Preserve wire URIs exactly. Never turn them into local paths without an explicit mapper; authorization normalization must not replace wire identity.
- Do not expose VS Code objects, PSI, or Serena types over the protocol.
- Capabilities must be truthful and handler-installed before publication. Unsupported provider/semantic behavior returns canonical unavailability/error; no approximate fallback.
- Never label textual work semantic/syntactic. Raw and anchored text guarantees remain explicit.
- VS Code extension host work is async and bounded. JetBrains PSI/index work stays off EDT, waits for smart mode, uses background reads/write commands, checks validity, cancels on close.
- External/provider DTOs are untrusted even after JSON Schema validation: independently verify adapter/session/workspace/epoch/URI ownership and structural bounds.
- Long or recursive external structures need bounds before recursive Ajv/provider processing.
- Errors and logs are payload-free: never log token, source text, replacements, full contents, or sensitive diagnostics.
- Prefer small single-purpose modules and injected host abstractions for unit tests.
- Preserve unrelated user changes. Do not delete tests or silently reduce scope.
- Audit first, implement, run targeted tests, post-audit races/security, run full gates, then document.
- Frequent progress notes are expected: completed action, evidence/result, next action.