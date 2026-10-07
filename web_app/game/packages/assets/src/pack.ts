export interface Placement { x: number; y: number; w: number; h: number; sliced?: { 9?: true; left?: number; top?: number; right?: number; bottom?: number }; }
export interface PackInput { name: string; w: number; h: number; slice9?: boolean }

export function packPlacements(items: PackInput[], opts: { maxSize?: number; padding?: number } = {}) {
  const maxSize = opts.maxSize ?? 2048;
  const pad = opts.padding ?? 1;
  const sorted = [...items].sort((a, b) => b.h - a.h || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic, code-unit — localeCompare is locale-dependent and would break byte-identical output across machines
  const frames: Record<string, Placement> = {};
  let x = 0, y = 0, shelfH = 0, width = 0;
  for (const it of sorted) {
    if (it.w + pad > maxSize || it.h + pad > maxSize) throw new Error(`item ${it.name} does not fit maxSize ${maxSize}`);
    if (x + it.w + pad > maxSize) { y += shelfH + pad; x = 0; shelfH = 0; }
    if (y + it.h + pad > maxSize) throw new Error(`items do not fit maxSize ${maxSize}`);
    frames[it.name] = { x, y, w: it.w, h: it.h,
      ...(it.slice9 ? { sliced: { 9: true as const, left: Math.round(it.w * 0.25), top: Math.round(it.h * 0.25), right: Math.round(it.w * 0.25), bottom: Math.round(it.h * 0.25) } } : {}) };
    x += it.w + pad;
    width = Math.max(width, x - pad);
    shelfH = Math.max(shelfH, it.h);
  }
  return { width, height: y + shelfH, frames };
}
