import { describe, expect, it } from "vitest";
import { nineSliceRect } from "./slice9.js";

// overlapsDst: half-open edge touch (a.x+a.w <= b.x …) is NOT an overlap —
// exact tiling has cells sharing edges, which must read as no-overlap
function overlapsDst(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]);
}

describe("nineSliceRect", () => {
  it("returns 9 quads whose dst areas tile the full rect without overlap", () => {
    const quads = nineSliceRect(100, 40, { left: 10, top: 10, right: 10, bottom: 10 }, 64, 24);
    expect(quads).toHaveLength(9);
    // top-left corner dst AND uv pinned (sprite-local px — uv convention: source pixels
    // relative to the frame origin; the renderer offsets by frame.x/frame.y):
    expect(quads[0]).toEqual({ dst: [0, 0, 10, 10], uv: [0, 0, 10, 10] });
    // center cell uv uses clamped source dims (srcW 64, slice 10 → smw 44; srcH 24, slice 10/10 → smh 4):
    expect(quads[4]).toEqual({ dst: [10, 10, 80, 20], uv: [10, 10, 44, 4] });
    // sum of dst areas === full rect
    expect(quads.reduce((s, q) => s + q.dst[2] * q.dst[3], 0)).toBe(4000);
    // pairwise no overlap (positive coverage + equal total area ⇒ exact tiling)
    for (let i = 0; i < quads.length; i++)
      for (let j = i + 1; j < quads.length; j++)
        expect(overlapsDst(quads[i]!.dst, quads[j]!.dst)).toBe(false);
  });

  it("degenerate slice (s >= half): exact tiling, no overlap, no zero/negative sizes", () => {
    const quads = nineSliceRect(10, 10, { left: 8, top: 8, right: 8, bottom: 8 }, 10, 10);
    expect(quads.every((q) => q.dst[2] > 0 && q.dst[3] > 0)).toBe(true);
    expect(quads.every((q) => q.uv[2] > 0 && q.uv[3] > 0)).toBe(true);
    // exact coverage: dst areas sum to the full rect (no double-covered cells)
    expect(quads.reduce((s, q) => s + q.dst[2] * q.dst[3], 0)).toBe(100);
    // pairwise no-overlap (positive coverage + equal total area ⇒ exact tiling)
    for (let i = 0; i < quads.length; i++)
      for (let j = i + 1; j < quads.length; j++)
        expect(overlapsDst(quads[i]!.dst, quads[j]!.dst)).toBe(false);
  });
});
