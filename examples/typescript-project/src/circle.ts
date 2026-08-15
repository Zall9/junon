/**
 * IDE Bridge — TypeScript fixture: class implementation of Shape.
 *
 * `Circle` implements the `Shape` interface from `./types.ts`.
 * This file provides the implementation side for multi-file reference
 * and rename tests.
 */

import { type Shape, circumference, π } from "./types.js";

/**
 * Immutable circle implementation of {@link Shape}.
 *
 * Rename target: renaming `Circle` should update references in
 * `tests/circle.test.ts` and `src/index.ts`.
 */
export class Circle implements Shape {
  readonly id: string;
  readonly label: string;

  /**
   * @param radius — positive radius.
   */
  constructor(
    readonly radius: number,
    id = "circle",
    label = `r=${radius}`,
  ) {
    if (radius <= 0) throw new Error("radius must be positive");
    this.id = id;
    this.label = label;
  }

  area(): number {
    return π * this.radius * this.radius;
  }

  scale(factor: number): void {
    if (factor <= 0) throw new Error("factor must be positive");
    // Immutable in this fixture — scale is a no-op stub.
  }

  /**
   * Circumference using the Unicode constant from `./types.ts`.
   */
  perimeter(): number {
    return circumference(this.radius);
  }
}
