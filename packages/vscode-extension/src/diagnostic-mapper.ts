/**
 * Maps VS Code diagnostics to IDEBP DTOs.
 *
 * Diagnostic text travels on the wire because it is the payload consumers ask for, but it never
 * reaches a log: the adapter's logger has a closed event catalogue and carries no payloads
 * (ADR-0011, ADR-0019). Nothing here formats a diagnostic for logging.
 */

import { IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT } from "@ide-bridge/protocol";
import type { Diagnostic, Range } from "@ide-bridge/protocol";

const MAX_RELATED_INFORMATION = 32;

/** VS Code `DiagnosticSeverity` is a numeric enum ordered error, warning, information, hint. */
const SEVERITIES = ["error", "warning", "information", "hint"] as const;

export interface VscodeDiagnosticLike {
  readonly range: unknown;
  readonly message: unknown;
  readonly severity?: unknown;
  readonly source?: unknown;
  readonly code?: unknown;
  readonly relatedInformation?: unknown;
}

export interface DiagnosticMapping {
  diagnostics: Diagnostic[];
  /** True when the document holds more diagnostics than the per-document ceiling allows. */
  truncated: boolean;
}

/**
 * Maps one document's diagnostics. Entries VS Code reports in a shape IDEBP cannot represent are
 * skipped rather than failing the whole snapshot: one malformed diagnostic from one extension must
 * not hide every other diagnostic in the workspace. Skipping sets `truncated`.
 */
export function mapVscodeDiagnostics(
  value: unknown,
  isWithinWorkspace: (uri: string) => boolean,
): DiagnosticMapping {
  if (!Array.isArray(value)) throw new Error("Diagnostics value is not an array");
  const diagnostics: Diagnostic[] = [];
  let truncated = false;
  for (const entry of value as unknown[]) {
    if (diagnostics.length >= IDEBP_MAX_DIAGNOSTICS_PER_DOCUMENT) {
      truncated = true;
      break;
    }
    const mapped = mapDiagnostic(entry, isWithinWorkspace);
    if (mapped === undefined) {
      truncated = true;
      continue;
    }
    diagnostics.push(mapped);
  }
  return { diagnostics, truncated };
}

function mapDiagnostic(
  value: unknown,
  isWithinWorkspace: (uri: string) => boolean,
): Diagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const range = readRange(value["range"]);
  const message = readMessage(value["message"]);
  if (range === undefined || message === undefined) return undefined;

  const severity = readSeverity(value["severity"]);
  const source = readNonEmptyString(value["source"]);
  const code = readCode(value["code"]);
  const relatedInformation = readRelatedInformation(value["relatedInformation"], isWithinWorkspace);
  return {
    range,
    positionEncoding: "utf-16",
    severity,
    message,
    ...(source === undefined ? {} : { source }),
    ...(code === undefined ? {} : { code }),
    ...(relatedInformation.length === 0 ? {} : { relatedInformation }),
  };
}

/**
 * Related information points at arbitrary locations, including files outside the workspace. Those
 * are dropped for the same reason navigation locations are (ADR-0018): the daemon enforces root
 * containment, and a diagnostic must not become a channel for reporting external paths.
 */
function readRelatedInformation(
  value: unknown,
  isWithinWorkspace: (uri: string) => boolean,
): NonNullable<Diagnostic["relatedInformation"]> {
  if (!Array.isArray(value)) return [];
  const related: NonNullable<Diagnostic["relatedInformation"]> = [];
  for (const entry of (value as unknown[]).slice(0, MAX_RELATED_INFORMATION)) {
    if (!isRecord(entry)) continue;
    const message = readMessage(entry["message"]);
    const location = entry["location"];
    if (message === undefined || !isRecord(location)) continue;
    const uri = readUri(location["uri"]);
    const range = readRange(location["range"]);
    if (uri === undefined || range === undefined || !isWithinWorkspace(uri)) continue;
    related.push({ location: { uri, range, positionEncoding: "utf-16" }, message });
  }
  return related;
}

function readSeverity(value: unknown): Diagnostic["severity"] {
  if (!Number.isSafeInteger(value)) return "error";
  const severity = SEVERITIES[Number(value)];
  // VS Code defaults an unset severity to Error; an unknown numeric value is treated the same way
  // rather than being downgraded to a hint, which would understate a real problem.
  return severity ?? "error";
}

function readMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length === 0 ? undefined : value;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCode(value: unknown): string | number | undefined {
  if (typeof value === "string") return value.length === 0 ? undefined : value;
  if (Number.isSafeInteger(value)) return Number(value);
  // VS Code also allows `{ value, target }`; only the value is representable in IDEBP.
  if (isRecord(value)) return readCode(value["value"]);
  return undefined;
}

function readUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["toString"] !== "function") return undefined;
  let uri: unknown;
  try {
    uri = (value as { toString(): unknown }).toString();
  } catch {
    return undefined;
  }
  return typeof uri === "string" && uri.length > 0 ? uri : undefined;
}

function readRange(value: unknown): Range | undefined {
  if (!isRecord(value)) return undefined;
  const start = readPosition(value["start"]);
  const end = readPosition(value["end"]);
  if (start === undefined || end === undefined) return undefined;
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
    return undefined;
  }
  return { start, end };
}

function readPosition(value: unknown): Range["start"] | undefined {
  if (!isRecord(value)) return undefined;
  const line = value["line"];
  const character = value["character"];
  if (!Number.isSafeInteger(line) || Number(line) < 0) return undefined;
  if (!Number.isSafeInteger(character) || Number(character) < 0) return undefined;
  return { line: Number(line), character: Number(character) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bounded prefix of a document's diagnostics that is asked for its fixes.
 *
 * Each entry costs a provider round trip. A document with hundreds of problems would spend the
 * request budget fetching offers nobody asked to see, and the daemon's route timeout is not a
 * theoretical limit here — it has already been hit once on this project.
 */
export const MAX_DIAGNOSTICS_WITH_FIXES = 20;

/** Matches the protocol ceiling; a longer list would be refused on the wire. */
const MAX_FIXES_PER_DIAGNOSTIC = 32;

/**
 * A stable identifier for one offer.
 *
 * Derived from the action's own kind and title rather than its position in a list, because a
 * consumer receives it in one snapshot and passes it back in a later request — and the list may
 * have changed by then. The adapter re-derives it at apply time and refuses when nothing matches,
 * so a superseded offer fails closed instead of applying whatever now occupies that slot.
 */
export function codeActionFixId(kind: string, title: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${kind} ${title}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The fixes a code-action provider offered, as the protocol reports them.
 *
 * Actions without an edit are dropped: a command-backed action runs arbitrary IDE behaviour, which
 * this adapter must not perform on a consumer's behalf, and offering one it would refuse to apply
 * would be worse than not offering it at all.
 */
export function mapCodeActions(value: unknown): { fixId: string; title: string }[] {
  if (!Array.isArray(value)) return [];
  const fixes: { fixId: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (fixes.length >= MAX_FIXES_PER_DIAGNOSTIC) break;
    if (!isRecord(entry)) continue;
    if (entry["edit"] === undefined || entry["edit"] === null) continue;
    const title = readNonEmptyString(entry["title"]);
    if (title === undefined) continue;
    const kind =
      readNonEmptyString((entry["kind"] as { value?: unknown } | undefined)?.value) ?? "";
    const fixId = codeActionFixId(kind, title);
    // A repeated identifier would make two offers indistinguishable, and the daemon's conformance
    // rules refuse that — so a duplicate is dropped rather than renumbered into something a later
    // request could not resolve back.
    if (seen.has(fixId)) continue;
    seen.add(fixId);
    fixes.push({ fixId, title });
  }
  return fixes;
}
