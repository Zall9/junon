/**
 * IDE Bridge — TypeScript fixture: barrel export and usage site.
 *
 * Re-exports public types and classes so that multi-file references
 * are visible to the IDE. `Circle` and `createCircle` are referenced
 * here, making this file part of the rename test surface.
 */

export { type Shape, createCircle, circumference, π } from "./types.js";
export { Circle } from "./circle.js";

import { Circle } from "./circle.js";
import { createCircle, type Shape } from "./types.js";

/**
 * Build a sample shape collection for fixture-level smoke testing.
 */
export function buildSampleShapes(): Shape[] {
  const c1 = new Circle(3);
  const c2 = createCircle(5);
  return [c1, c2];
}
