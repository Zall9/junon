# integrations/serena/ide_bridge/
## Responsibility

Python-side typed data models and configuration for the IDE Bridge Serena integration backend. Defines the IDEBP protocol entity representations (symbol handles, positions, ranges, document revisions, capability declarations, workspace info, error responses, symbol kind vocabulary) and the configuration shape that Phase 6 will use to connect to the IDE Bridge daemon. `models.py` now has 287 lines with a symbol kind vocabulary matching the protocol. Zero runtime dependencies beyond the Python standard library.

## Design Patterns
- **Frozen + Slots Dataclasses**: All 7 data models and `IdeBridgeConfig` use `@dataclass(frozen=True, slots=True)` (models.py:72, 104, 122, 138, 170, 198, 225; config.py:46). Immutability prevents accidental mutation of protocol entities. `slots=True` reduces memory and prevents attribute creation.
- **`__post_init__` Validation**: Every frozen dataclass validates its fields in `__post_init__`, raising `ValueError` for invalid inputs at construction time (models.py:93, 115, 129, 155, 188, 214, 239; config.py:71). This ensures no invalid protocol entity can exist.
- **NewType for Domain Primitives**: `WorkspaceId`, `AdapterId`, `DocumentUri` are `NewType("...", str)` wrappers (models.py:26-32) providing type-safety without runtime overhead. They are plain `str` at runtime but distinct in the type system.
- **String Enums**: `CapabilitySupport` and `CapabilityGuarantee` are `str, Enum` mixins (models.py:38, 53) — they compare equal to their string values and serialize as strings.
- **Sentinel Types via `Literal`/`Union`**: `PathSpec = Union[Literal["auto"], str]` and `WorkspaceSpec = Union[AutoSentinel, str]` (config.py:28-34) encode the "auto" sentinel in the type system.
- **Public API Facade**: `__init__.py` re-exports `IdeBridgeConfig` and all 12 model types via `__all__` (lines 28-43), making `from ide_bridge import X` work for all public types.

## Key Types
- `WorkspaceId = NewType("WorkspaceId", str)` (models.py:26) — Opaque workspace identifier assigned by the daemon.
- `AdapterId = NewType("AdapterId", str)` (models.py:29) — Opaque adapter identifier (e.g. `"vscode"`, `"jetbrains"`).
- `DocumentUri = NewType("DocumentUri", str)` (models.py:32) — Document URI. Must be preserved as-is, never converted to a local path (AGENTS.md §2).
- `SYMBOL_KINDS: tuple[str, ...]` (models.py:48-76) — 26 symbol kinds transcribed from `schemas/common/symbol.schema.json`, in schema order. Python has no generated mirror of the schemas the way Kotlin and TypeScript do, so the transcription is done by hand. `test_symbol_kinds.py` reads the schema and fails when these disagree — the same content-based guard the VS Code capability list uses, for the same reason. `unknown` is the protocol's own member, not a sentinel added here: it is the truthful answer for a declaration whose category the IDE does not name, and callers that filter must decide what to do about it rather than have it silently vanish.
- `UNCLASSIFIED = "unknown"` (models.py:79) — the kind reported for a declaration the IDE declined to classify. The protocol's own member, not a sentinel.
- `CapabilitySupport(str, Enum)` (models.py:38) — `SUPPORTED="supported"`, `UNSUPPORTED="unsupported"`, `UNKNOWN="unknown"`. Mirrors IDEBP capability model (TASK.md §8).
- `CapabilityGuarantee(str, Enum)` (models.py:53) — `SEMANTIC="semantic"`, `SYNTACTIC="syntactic"`, `TEXTUAL="textual"`. Per AGENTS.md §1, a textual edit must never be labelled `semantic` or `syntactic`.
- `SymbolHandle` (models.py:72) — `frozen, slots`. Fields: `handle: str`, `adapter_id: AdapterId`, `workspace_id: WorkspaceId`, `uri: DocumentUri`. Opaque, adapter-scoped symbol reference. Not portable across sessions/adapters (lines 76-80 docstring).
- `Position` (models.py:104) — `frozen, slots`. Fields: `line: int`, `character: int`. Zero-based, UTF-16 code units (LSP conventions, lines 108-109).
- `Range` (models.py:122) — `frozen, slots`. Fields: `start: Position`, `end: Position`. Structural validation only — no `start <= end` check in Phase 0 (lines 130-131 comment).
- `DocumentRevision` (models.py:138) — `frozen, slots`. Fields: `editor_version: int`, `content_hash: str`, `workspace_epoch: int`. Revision precondition for edits (AGENTS.md §2, §5).
- `CapabilityDeclaration` (models.py:170) — `frozen, slots`. Fields: `method: str`, `support: CapabilitySupport`, `guarantee: CapabilityGuarantee`, `unavailable_reason: str = ""`. Enforces invariant: `unavailable_reason` must be empty when `support == SUPPORTED` (lines 191-195).
- `WorkspaceInfo` (models.py:198) — `frozen, slots`. Fields: `workspace_id: WorkspaceId`, `name: str`, `root_uri: DocumentUri`, `adapter_id: AdapterId`.
- `ErrorResponse` (models.py:225) — `frozen, slots`. Fields: `code: str`, `message: str`, `data: dict[str, str] = field(default_factory=dict)`.
- `IdeBridgeConfig` (config.py:46) — `frozen, slots`. Fields: `discovery_file: PathSpec = "auto"`, `workspace: WorkspaceSpec = "auto"`, `request_timeout_seconds: int = 30`, `prefer_adapter: tuple[AdapterId, ...] = ("jetbrains", "vscode")`. Mirrors TASK.md §21 YAML structure.
- `PathSpec` (config.py:31) — `Union[Literal["auto"], str]`. `WorkspaceSpec` (config.py:34) — `Union[AutoSentinel, str]`.
- `DEFAULT_REQUEST_TIMEOUT_SECONDS = 30` (config.py:37), `DEFAULT_PREFER_ADAPTER = (AdapterId("jetbrains"), AdapterId("vscode"))` (config.py:40-43).

## Key Functions
- `IdeBridgeConfig.__post_init__()` (config.py:71) — Validates: `request_timeout_seconds > 0` (line 73), `prefer_adapter` not empty (line 78), each adapter ID is a non-empty stripped string (lines 81-86).
- `default_config() -> IdeBridgeConfig` (config.py:89) — Factory returning `IdeBridgeConfig()` with defaults matching TASK.md §21.
- `SymbolHandle.__post_init__()` (models.py:93) — Rejects empty `handle`, `adapter_id`, `workspace_id`, `uri`.
- `Position.__post_init__()` (models.py:115) — Rejects negative `line` or `character`.
- `Range.__post_init__()` (models.py:129) — Rejects `None` for `start` or `end` (structural only, no `start <= end` check — deferred to adapter runtime, lines 130-131).
- `DocumentRevision.__post_init__()` (models.py:155) — Rejects negative `editor_version`, empty `content_hash`, negative `workspace_epoch`.
- `CapabilityDeclaration.__post_init__()` (models.py:188) — Rejects empty `method`. Rejects `unavailable_reason` non-empty when `support == SUPPORTED` (lines 191-195).
- `WorkspaceInfo.__post_init__()` (models.py:214) — Rejects empty `workspace_id`, `name`, `root_uri`, `adapter_id`.
- `ErrorResponse.__post_init__()` (models.py:239) — Rejects empty `code` or `message`.

## Data & Control Flow
No runtime data flow — these are pure data containers. Construction is the only entry point:

1. **Model construction**: Caller provides field values → `@dataclass.__init__` → `__post_init__` validation → either returns immutable instance or raises `ValueError`.
2. **Config construction**: `IdeBridgeConfig()` (or `default_config()`) → `__post_init__` validates timeout and adapter list → returns frozen config.
3. **Consumption (future)**: Phase 6 will read these models from JSON-RPC responses, construct them, and pass them to Serena tool implementations. Later phases will add serialization/deserialization.

No methods exist on any model beyond `__init__`/`__post_init__` — this is by design (models.py:12-14 comment).

## Integration Points
- **Consumed by**: `integrations/serena/tests/test_models.py` and `test_config.py` (unit tests for all models and config). `test_symbol_kinds.py` reads the JSON schema and asserts `SYMBOL_KINDS` matches, failing when the two disagree. Phase 6 Serena backend will import from `ide_bridge` package.
- **Depends on**: Python standard library only (`dataclasses`, `enum`, `typing`). Zero external runtime dependencies.
- **External boundaries**: `IdeBridgeConfig.discovery_file` — when not `"auto"`, this is a filesystem path (not yet read in Phase 0). `IdeBridgeConfig.workspace` — when not `"auto"`, an explicit workspace ID string. `prefer_adapter` — adapter ID strings (`"jetbrains"`, `"vscode"`). No env vars or file paths are accessed in Phase 0.

## Common Gotchas
- **URI values must never be converted to local paths** — `DocumentUri` and `WorkspaceInfo.root_uri` preserve URIs as-is (models.py:31, 85-86, 206-207). `SymbolHandle.uri` and `WorkspaceInfo.root_uri` can be remote URIs (`ssh://...`). Test `test_remote_uri_preserved` / `test_remote_root_uri_preserved` enforce this (test_models.py:149-158, 271-279). AGENTS.md §2.
- **`CapabilityDeclaration` invariant**: `unavailable_reason` must be empty when `support == SUPPORTED` (models.py:191-195). Test `test_supported_with_reason_rejected` enforces this (test_models.py:218-226). Violating this invariant raises `ValueError` at construction.
- **`Range` does not check `start <= end`** — this is intentional in Phase 0 (models.py:130-131 comment). The adapter enforces this at runtime. Do not add a `start <= end` check to `__post_init__` without a protocol-level decision.
- **`Position` uses UTF-16 code units, not Unicode code points** — character offsets follow LSP conventions (models.py:109). This matters for documents with characters outside the BMP.
- **`prefer_adapter` is a `tuple`, not a `list`** — `tuple[AdapterId, ...]` (config.py:67). Using a list would break immutability since the dataclass is frozen. The default uses `field(default_factory=lambda: DEFAULT_PREFER_ADAPTER)` (config.py:68-69).
- **`__version__` is `"0.0.0"`** — Skeleton version (`__init__.py:26`). Will be bumped when the backend gains functionality.
- **NewTypes are `str` at runtime** — `WorkspaceId("ws-1")` is literally the string `"ws-1"`. `isinstance(wid, str)` is `True` (test_models.py:39). They provide no runtime type-safety, only static type-checker safety.
- **`CapabilitySupport` and `CapabilityGuarantee` are `str` enums** — `CapabilitySupport.SUPPORTED == "supported"` is `True` (test_models.py:56). They serialize as their string values without custom encoders.
- **`SYMBOL_KINDS` is hand-transcribed, not generated** — Python has no code generator for the JSON schemas, so the 26-member tuple (models.py:48-76) is transcribed from `schemas/common/symbol.schema.json`. A transcription drifts, which is why `test_symbol_kinds.py` reads the schema and fails when the two disagree. Adding a kind to the schema without adding it here (or vice versa) would break that test, not a downstream consumer — which is the point.
