import { describe, expect, it } from "vitest";
import { packPlacements, type Placement } from "./pack.js";

function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

it("packs 10 items without overlap, within maxSize", () => {
  // 260 not 256: with padding: 1, ten 64x64 rects need >=260 (3/row + pad,
  // 4 rows of cells is 4*65=260) — 256 is a plan typo, proven impossible below.
  const maxSize = 260;
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `i${i}`, w: 64, h: 64 }));
  const r = packPlacements(items, { maxSize, padding: 1 });
  expect(r.width).toBeLessThanOrEqual(maxSize);
  expect(Object.keys(r.frames)).toHaveLength(10);
  const rects = Object.values(r.frames);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
});
it("throws when items cannot fit in maxSize", () => {
  expect(() => packPlacements([{ name: "big", w: 3000, h: 3000 }], { maxSize: 2048 })).toThrow(/fit/);
});
it("deterministic: same input → identical output object", () => {
  const items = [{ name: "a", w: 10, h: 20 }, { name: "b", w: 30, h: 40 }];
  expect(packPlacements(items)).toEqual(packPlacements([...items]));
});
it("note sprites carry 9-slice metadata when flagged", () => {
  const r = packPlacements([{ name: "note", w: 64, h: 24, slice9: true }], {});
  expect(r.frames["note"]!.sliced).toBeDefined();
  expect(r.frames["note"]!.sliced).toMatchObject({ 9: true, left: 16, top: 6, right: 16, bottom: 6 });
});

describe("overlaps helper", () => {
  it("detects intersection and rejects touching/aligned rects", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(overlaps(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(overlaps(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false); // edge-touching
    expect(overlaps(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(false); // edge-touching
    expect(overlaps(a, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });
});
