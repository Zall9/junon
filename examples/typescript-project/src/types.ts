/**
 * IDE Bridge — TypeScript fixture: public interfaces and overloads.
 *
 * This file defines a public interface, overloaded function signatures,
 * and a Unicode identifier (π) to exercise IDE symbol resolution across
 * multi-file references, overloads, and non-ASCII symbol names.
 */

// ── Interface ───────────────────────────────────────────────────────

/**
 * Shape of a geometric shape that can report its area.
 */
export interface Shape {
  /** Stable identifier for the shape. */
  readonly id: string;
  /** Human-readable label (may contain Unicode). */
  readonly label: string;
  /** Compute the area of the shape. */
  area(): number;
  /** Scale the shape by a positive factor. */
  scale(factor: number): void;
}

// ── Overloaded function ─────────────────────────────────────────────

/**
 * Create a circle from a radius (number) or from a diameter string
 * like `"d=10"`. Demonstrates TypeScript overload signatures for
 * IDEBP overload-resolution tests.
 */
export function createCircle(radius: number): Shape;
export function createCircle(diameterExpression: string): Shape;
export function createCircle(value: number | string): Shape {
  const radius = typeof value === "number" ? value : parseDiameter(value);
  return {
    id: "circle",
    label: `r=${radius}`,
    area: () => Math.PI * radius * radius,
    scale: (factor: number) => {
      if (factor <= 0) throw new Error("factor must be positive");
      // circles are immutable in this fixture; scale is a no-op stub
    },
  };
}

// ── Unicode symbol ──────────────────────────────────────────────────

/**
 * Compute the mathematical constant π using the Unicode identifier `π`.
 * Exercises non-ASCII symbol names in IDE symbol resolution.
 */
export const π = Math.PI;

/**
 * Compute the circumference of a circle with radius `r` using the
 * Unicode constant `π`.
 */
export function circumference(r: number): number {
  return 2 * π * r;
}

// ── Helper ──────────────────────────────────────────────────────────

function parseDiameter(expr: string): number {
  const match = expr.match(/^d=(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`invalid diameter expression: ${expr}`);
  return Number(match[1]) / 2;
}
