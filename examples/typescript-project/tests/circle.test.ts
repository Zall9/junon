/**
 * IDE Bridge — TypeScript fixture: rename test surface.
 *
 * This test file references `Circle` and `createCircle` so that
 * renaming either symbol must update this file as well as `src/`.
 * It also exercises the Unicode symbol `π`.
 */

import { describe, it, expect } from "vitest";
import { Circle } from "../src/circle.js";
import { createCircle, circumference, π } from "../src/types.js";

describe("Circle", () => {
  it("computes area using π", () => {
    const c = new Circle(2);
    expect(c.area()).toBe(π * 4);
  });

  it("computes perimeter via circumference", () => {
    const c = new Circle(3);
    expect(c.perimeter()).toBe(circumference(3));
  });
});

describe("createCircle (overloads)", () => {
  it("accepts a numeric radius", () => {
    const c = createCircle(4);
    expect(c.area()).toBe(π * 16);
  });

  it("accepts a diameter expression string", () => {
    const c = createCircle("d=10");
    expect(c.area()).toBeCloseTo(π * 25, 10);
  });
});
