// Pure 9-slice geometry — no renderer/GL imports (unit-testable in isolation).
// UV convention: source pixels SPRITE-LOCAL (relative to the atlas frame's origin);
// the renderer converts to atlas-absolute (frame.x + u) then normalizes 0..1.
// 4th/5th args are the SOURCE sprite dims (for uv in sprite-local px).
export interface Slice { left: number; top: number; right: number; bottom: number }
export interface Quad { dst: [x: number, y: number, w: number, h: number]; uv: [u: number, v: number, du: number, dv: number] }

export function nineSliceRect(w: number, h: number, s: Slice, srcW: number, srcH: number): Quad[] {
  let cw = Math.min(s.left, Math.floor(w / 2)), rw = Math.min(s.right, Math.floor(w / 2));
  let th = Math.min(s.top, Math.floor(h / 2)), bh = Math.min(s.bottom, Math.floor(h / 2));
  let mw = w - cw - rw, mh = h - th - bh;
  // degenerate slices: shrink the right/bottom edge so the three regions EXACTLY tile w/h —
  // never let cw+rw exceed w (Math.max(1, …) alone would OVERLAP and break tiling)
  if (mw < 1) { rw = Math.max(1, w - cw - 1); mw = w - cw - rw; }
  if (mh < 1) { bh = Math.max(1, h - th - 1); mh = h - th - bh; }
  if (mw < 1 || mh < 1 || w < 3 || h < 3) throw new Error("nineSliceRect: rect too small for a 3×3 slice (min 3×3 px)");
  const dstXs = [0, cw, cw + mw], dstYs = [0, th, th + mh];
  const dstWs = [cw, mw, rw], dstHs = [th, mh, bh];
  // source cells clamp the same way against srcW/srcH
  const scw = Math.min(s.left, Math.floor(srcW / 2)), srw = Math.min(s.right, Math.floor(srcW / 2));
  const sth = Math.min(s.top, Math.floor(srcH / 2)), sbh = Math.min(s.bottom, Math.floor(srcH / 2));
  const smw = Math.max(1, srcW - scw - srw), smh = Math.max(1, srcH - sth - sbh);
  const srcXs = [0, scw, scw + smw], srcYs = [0, sth, sth + smh];
  const srcWs = [scw, smw, srw], srcHs = [sth, smh, sbh];
  const quads: Quad[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      quads.push({
        dst: [dstXs[c]!, dstYs[r]!, dstWs[c]!, dstHs[r]!],
        uv: [srcXs[c]!, srcYs[r]!, srcWs[c]!, srcHs[r]!],
      });
    }
  }
  return quads;
}
