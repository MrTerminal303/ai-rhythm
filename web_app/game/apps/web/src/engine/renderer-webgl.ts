import { KEY_COUNT, type Beatmap } from "@airhythm/shared";
import { nineSliceRect, type Slice } from "./slice9.js";
import type { NoteState, Renderer } from "./types.js";

/** Default scroll speed (px/ms) — presentation-only; the settings default reads THIS value.
 *  A per-instance `scrollSpeed` option overrides it (T22), so this stays the unchanged base. */
export const SCROLL_PX_PER_MS = 0.5;
const MAX_QUADS = 4096;
const MAX_VERTICES = MAX_QUADS * 6; // 2 triangles × 3 verts per quad
const FLOATS_PER_VERTEX = 6; // x,y,r,g,b,a
const FLOATS_PER_VERTEX_TEX = 8; // textured: x,y,u,v,r,g,b,a

// atlas frames used by the note path (W2 T22) — role map from T20 report: the flat
// button rect is the tintable note head; the wide slide section is the hold body bar
const TAP_FRAME = "ui/button_rectangle_flat";
const HOLD_FRAME = "ui/slide_horizontal_grey_section_wide";

interface AtlasFrameRect { x: number; y: number; w: number; h: number }
interface AtlasFrame extends AtlasFrameRect { slice: Slice }
type AtlasFrames = { tap: AtlasFrame; hold: AtlasFrame };
interface AtlasJson {
  meta: { size: { width: number; height: number } };
  frames: Record<string, AtlasFrameRect | undefined>;
}

// §2.8 position rule as a pure function — exported so engine-render.test.ts pins the
// real production math (y = hitLineY - dt * scrollPxPerMs), not a test re-implementation.
// `downscroll` (W3 T22) mirrors the result about the hit line, so notes approach the
// judgement line from ABOVE; both directions meet exactly at the hit line.
export function noteY(
  noteT: number,
  chartTimeMs: number,
  hitLineY: number,
  scrollPxPerMs: number,
  downscroll = false,
): number {
  const y = hitLineY - (noteT - chartTimeMs) * scrollPxPerMs;
  return downscroll ? 2 * hitLineY - y : y;
}

const HIT_FLASH_MS = 200; // hit flash fades out over 200 ms from the transition frame
const MISS_FLASH_MS = 400; // missed flash fades out over 400 ms (the HUD MISS red read)

/** linear fade of the hit/missed flash: 1 at the transition frame, 0 at the duration */
export function flashAlpha(kind: "hit" | "missed", elapsedMs: number): number {
  const duration = kind === "hit" ? HIT_FLASH_MS : MISS_FLASH_MS;
  if (elapsedMs <= 0) return 1;
  if (elapsedMs >= duration) return 0;
  return 1 - elapsedMs / duration;
}

interface RendererOptions {
  /** A7: fired on `webglcontextlost` (once per loss); the page maps it to enterPause("paused") */
  onContextLost?: () => void;
  /** A7: fired on `webglcontextrestored` (GL resources rebuilt by then) */
  onContextRestored?: () => void;
  /** W3 T22: px/ms travel speed; defaults to SCROLL_PX_PER_MS (presentation only, C10) */
  scrollSpeed?: number;
  /** W3 T22: notes fall toward the hit line from above (presentation only, C10) */
  downscroll?: boolean;
}

export class WebGLRenderer implements Renderer {
  private readonly gl: WebGL2RenderingContext;
  // A7: NOT readonly — initGL() reassigns these on context restore; definite-assignment
  // asserts because the assignment happens inside the private initGL() call in the ctor
  private program!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private readonly verts = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
  private vertCount = 0; // counts VERTICES (increments of 6)
  private width = 0;
  private height = 0;
  private hitLineY = 0;
  private readonly noteColor: readonly [number, number, number];
  private laneX: [number, number, number, number] = [0, 0, 0, 0];
  private laneW = 0;
  // W2 T22 atlas path — everything here builds SYNCHRONOUSLY at construction so the
  // play page can set webglReady with no await (B6); only the texture load is async
  private texProgram!: WebGLProgram;
  private texBuffer!: WebGLBuffer;
  private readonly texVerts = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX_TEX);
  private texVertCount = 0;
  private locPos!: number;
  private locCol!: number;
  private texSamplerLoc!: WebGLUniformLocation;
  private atlasTex: WebGLTexture | null = null;
  private atlasFrames: AtlasFrames | null = null;
  private atlasSize: { w: number; h: number } | null = null;
  private atlasInitStarted = false; // race guard: initAtlas transitions state at most once
  private atlasInitPromise: Promise<boolean> | null = null;
  // A9: permanent atlas outcome — "loaded" (texture path active) or "fallback" (code-drawn,
  // set once on timeout/error and NEVER retried per session). Public read-only seam for
  // atlas-fallback.test.ts and the e2e "no unhandled rejection" check.
  private _atlasState: "loaded" | "fallback" | null = null;
  /** A9 test seam: current atlas outcome (null until initAtlas settles). */
  get atlasState(): "loaded" | "fallback" | null { return this._atlasState; }
  private disposed = false;
  /** test seam (W2 T22): cumulative gl.drawArrays calls per pipeline since construction */
  readonly drawCounts = { solid: 0, textured: 0 };
  /** W3 T22: the presentation opts this instance actually resolved (e2e reads them back) */
  get appliedPresentation(): { scrollSpeed: number; downscroll: boolean } {
    return { scrollSpeed: this.scrollPxPerMs, downscroll: this.downscroll };
  }

  /**
   * W3 T22: apply the presentation opts read at run start. Called by the play page's
   * startGame (settings are read THERE — the constructor runs at mount, before the click).
   * Presentation only (C10): the note path and the frozen flash Y read the same pair, so a
   * change can never leave a flash drawn at a stale position.
   */
  setPresentation(opts: { scrollSpeed?: number; downscroll?: boolean }): void {
    if (opts.scrollSpeed !== undefined) this.scrollPxPerMs = opts.scrollSpeed;
    if (opts.downscroll !== undefined) this.downscroll = opts.downscroll;
  }
  /** test seam: solid-batch vertex count left by the most recent render() */
  get solidVertCount(): number { return this.vertCount; }
  /** A7: whether the WebGL context is currently lost (prevents GL calls while context is down) */
  private lost = false;
  /** peak color of the hit flash — noteColor lightened toward white for punch */
  private readonly hitFlashColor: readonly [number, number, number];
  // W1→W2 deferral: per-note flash transition tracking — O(1) state allocated once in
  // the ctor (chart length is known there); the rAF path never allocates
  private readonly flashKind: Uint8Array; // 0 none/pending, 1 hit, 2 missed
  private readonly flashStartedAt: Float64Array; // performance.now() at the transition
  private readonly flashY: Float32Array; // y frozen at the transition frame (§flash position)
  /** W3 T22 presentation options — constructed from the initial opts, then set by startGame */
  private scrollPxPerMs: number;
  private downscroll: boolean;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly chart: Beatmap,
    private readonly opts: RendererOptions = {},
  ) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.initGL();
    // §6.1 tokens are the color source of truth: read --you once at construction
    // (canvas inherits it); fallback keeps rendering identical if the var is absent
    this.noteColor = hexToRgb(getComputedStyle(canvas).getPropertyValue("--you")) ?? NOTE_COLOR;
    // hit flash peak: same accent lightened 35% toward white (bright pop at the hit line)
    const nc = this.noteColor;
    this.hitFlashColor = [
      nc[0] + (1 - nc[0]) * 0.35,
      nc[1] + (1 - nc[1]) * 0.35,
      nc[2] + (1 - nc[2]) * 0.35,
    ];
    // flash state sized to the chart — one allocation at construction, O(1) per note after
    this.flashKind = new Uint8Array(this.chart.notes.length);
    this.flashStartedAt = new Float64Array(this.chart.notes.length);
    this.flashY = new Float32Array(this.chart.notes.length);
    // W3 T22 presentation options — resolved ONCE here (the page reads settings at startGame)
    this.scrollPxPerMs = opts.scrollSpeed ?? SCROLL_PX_PER_MS;
    this.downscroll = opts.downscroll ?? false;
    // A7: context-loss boundary — handlers registered on the GL CONTEXT, so they survive
    // the program/buffer objects (a restored context keeps its event listeners)
    this.attachContextHandlers();
    this.resize();
  }

  /**
   * A7: rebuild the GL resources on a fresh context. Called from the constructor and from
   * the `webglcontextrestored` handler — on restore the context is a NEW implementation with
   * zero prior state, so every program/buffer/attrib must be re-created and re-bound.
   * The atlas state is CLEARED and its load RE-ARMED here (dead texture object, atlasInitStarted
   * reset); the page's onContextRestored callback re-invokes initAtlas() to re-fetch and re-upload
   * it — until that settles the textured path falls back to code-drawn, and a failed re-fetch
   * (T13's 5 s timeout) commits the permanent code-drawn state instead of hanging.
   */
  private initGL(): void {
    const gl = this.gl;
    this.program = buildProgram(gl);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_pos");
    const col = gl.getAttribLocation(this.program, "a_col");
    this.locPos = loc;
    this.locCol = col;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col, 4, gl.FLOAT, false, 24, 8);
    // lane/note colors use alpha — blending required or colors render wrong
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // textured pipeline (W2 T22): program + buffer sync like the solid path —
    // the atlas TEXTURE itself loads later via initAtlas (off the readiness path)
    this.texProgram = buildTextureProgram(gl);
    this.texBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.texVerts.byteLength, gl.DYNAMIC_DRAW);
    this.texSamplerLoc = gl.getUniformLocation(this.texProgram, "u_tex")!;
    // On restore the prior texture object is dead — clear the atlas state and RE-ARM the load
    // (atlasInitStarted back to false) so the page's onContextRestored → initAtlas() re-fetches
    // and re-uploads it; until then the textured path falls back to code-drawn.
    this.atlasTex = null;
    this.atlasSize = null;
    this.atlasFrames = null;
    this.atlasInitStarted = false;
    this.atlasInitPromise = null;
  }

  /**
   * A7: register the two GL context lifecycle handlers on the CANVAS (the real
   * `webglcontextlost`/`webglcontextrestored` dispatch on the canvas element — the
   * renderer must be constructible on unit-test stub contexts that lack addEventListener).
   *  - `webglcontextlost`: preventDefault() (required — without it the browser will not
   *    attempt to restore the context), then fire onContextLost ONCE per loss.
   *  - `webglcontextrestored`: rebuild program/buffers via initGL() (which also clears the dead
   *    atlas texture and re-arms its load), then fire onContextRestored — the page callback
   *    re-invokes initAtlas() so the atlas is re-fetched and re-uploaded.
   */
  private attachContextHandlers(): void {
    this.canvas.addEventListener("webglcontextlost", ((e: Event) => {
      (e as { preventDefault(): void }).preventDefault();
      if (!this.lost) {
        this.lost = true;
        this.opts.onContextLost?.();
      }
    }) as EventListener);
    this.canvas.addEventListener("webglcontextrestored", (() => {
      this.lost = false;
      this.initGL();
      this.opts.onContextRestored?.();
    }) as EventListener);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // u_res is per-program uniform state — set on both pipelines (W2 T22), restore
    // the solid program as active so construction leaves the same state as before
    this.gl.useProgram(this.texProgram);
    this.gl.uniform2f(this.gl.getUniformLocation(this.texProgram, "u_res"), this.width, this.height);
    this.gl.useProgram(this.program);
    // u_res in CSS pixels — geometry (laneX/laneW/hitLineY) is authored in CSS px;
    // using canvas.width/height (physical px) would shrink the highway by dpr on HiDPI
    this.gl.uniform2f(this.gl.getUniformLocation(this.program, "u_res"), this.width, this.height);
    const highwayW = Math.min(480, this.width * 0.4);
    const x0 = (this.width - highwayW) / 2;
    this.laneW = highwayW / KEY_COUNT;
    this.laneX = [x0, x0 + this.laneW, x0 + this.laneW * 2, x0 + this.laneW * 3];
    this.hitLineY = this.height * 0.82;
  }

  render(chartTimeMs: number, noteStates: readonly NoteState[]): void {
    if (this.lost) return; // context down — the page has paused the game; no GL calls
    const gl = this.gl;
    this.vertCount = 0;
    this.texVertCount = 0;
    gl.clearColor(10 / 255, 12 / 255, 16 / 255, 1); // --bg #0A0C10
    gl.clear(gl.COLOR_BUFFER_BIT);

    // lane panels + receptors (code-drawn, §6.5.1 "drawn in code, no sprites")
    for (let lane = 0; lane < KEY_COUNT; lane++) {
      const x = this.laneX[lane]!;
      this.quad(x, 0, this.laneW, this.height, 1, 1, 1, 0.03);
      this.quad(x, this.hitLineY - 6, this.laneW, 12, 1, 1, 1, 0.8); // receptor
    }
    this.quad(this.laneX[0]!, this.hitLineY - 1, this.laneW * KEY_COUNT, 2, 1, 1, 1, 0.8); // hit line (2px, §6.2)

    // notes: dt = note.t - chartTime; y = hitLineY - dt * scrollPxPerMs (§2.8, via noteY)
    // atlas snapshot per frame: once loaded, notes switch from the NEXT render on
    // (never switches back — atlasFrames is only ever set, never cleared mid-play)
    const atlas = this.atlasFrames;
    for (const [i, note] of this.chart.notes.entries()) {
      const state = noteStates[i];
      if (state === "hit" || state === "missed") {
        // W1→W2 deferral landed: resolved notes flash at the y they had when their state
        // changed (frozen — chartTime no longer moves them), then are culled at fade end
        const kind = state === "hit" ? 1 : 2;
        const now = performance.now();
        if (this.flashKind[i] !== kind) {
          this.flashKind[i] = kind;
          this.flashStartedAt[i] = now;
          // the flash freezes at the SAME y the note path would draw — one speed + one flip,
          // so a hit note's flash can never appear at a stale position (T22 presentation)
          this.flashY[i] = noteY(note.t, chartTimeMs, this.hitLineY, this.scrollPxPerMs, this.downscroll);
        }
        const a = flashAlpha(state, now - this.flashStartedAt[i]!);
        if (a <= 0) continue; // fade complete — zero draws for this note from here on
        const fy = this.flashY[i]!;
        if (fy < -40 || fy > this.height + 40) continue;
        const fc = state === "hit" ? this.hitFlashColor : MISS_FLASH_COLOR;
        this.quad(this.laneX[note.lane]! + 4, fy - 14, this.laneW - 8, 28, fc[0], fc[1], fc[2], a);
        continue;
      }
      if (state !== "pending") continue; // short noteStates array: undefined skipped as before
      const y = noteY(note.t, chartTimeMs, this.hitLineY, this.scrollPxPerMs, this.downscroll);
      if (y < -40 || y > this.height + 40) continue;
      const x = this.laneX[note.lane]!;
      const c = this.noteColor;
      if (note.type === "hold" && note.d !== undefined) {
        // hold body (W2 T17): rect from head y to tail y at 35% opacity (§6.2)
        const yTail = noteY(note.t + note.d, chartTimeMs, this.hitLineY, this.scrollPxPerMs, this.downscroll);
        const top = Math.min(y, yTail);
        const h = Math.abs(yTail - y);
        if (top < this.height + 40 && top + h > -40) {
          const bodyH = Math.max(h, 2);
          if (!atlas || !this.texturedSlice(x + 4, top, this.laneW - 8, bodyH, atlas.hold, c[0], c[1], c[2], 0.35)) {
            this.quad(x + 4, top, this.laneW - 8, bodyH, c[0], c[1], c[2], 0.35);
          }
        }
      }
      if (!atlas || !this.texturedSlice(x + 4, y - 14, this.laneW - 8, 28, atlas.tap, c[0], c[1], c[2], 1)) {
        this.quad(x + 4, y - 14, this.laneW - 8, 28, c[0], c[1], c[2], 1);
      }
    }

    // solid batch (lanes, receptors, hit line, code-drawn notes) — attrib pointers are
    // re-bound per draw because the textured pass overwrites them (two programs, one context)
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    this.bindSolidAttribs();
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.vertCount * FLOATS_PER_VERTEX));
    gl.drawArrays(gl.TRIANGLES, 0, this.vertCount);
    this.drawCounts.solid++;
    // textured batch (W2 T22): ONE texture bind + one draw for every atlas note in frame
    if (this.texVertCount > 0 && this.atlasTex) {
      gl.useProgram(this.texProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.uniform1i(this.texSamplerLoc, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
      this.bindTexturedAttribs();
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.texVerts.subarray(0, this.texVertCount * FLOATS_PER_VERTEX_TEX));
      gl.drawArrays(gl.TRIANGLES, 0, this.texVertCount);
      this.drawCounts.textured++;
    }
  }

  private quad(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    if (this.vertCount + 6 > MAX_VERTICES) return; // pool cap — avoids large per-frame buffer growth (small per-call closures/iterators remain)
    const v = this.verts;
    let o = this.vertCount * FLOATS_PER_VERTEX;
    const put = (px: number, py: number) => {
      v[o++] = px; v[o++] = py; v[o++] = r; v[o++] = g; v[o++] = b; v[o++] = a;
    };
    put(x, y); put(x + w, y); put(x + w, y + h);
    put(x, y); put(x + w, y + h); put(x, y + h);
    this.vertCount += 6;
  }

  /** re-bind solid-program attribs — the textured pass overwrites shared slots 0..2 */
  private bindSolidAttribs(): void {
    const gl = this.gl;
    // disable ALL textured slots first so no stale array stays enabled, regardless of
    // where getAttribLocation placed the solid program's inputs (not spec-pinned)
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.enableVertexAttribArray(this.locPos);
    gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this.locCol);
    gl.vertexAttribPointer(this.locCol, 4, gl.FLOAT, false, 24, 8);
  }

  /** layout(location=0/1/2) = pos/uv/tint, stride 32 (x,y,u,v,r,g,b,a) */
  private bindTexturedAttribs(): void {
    const gl = this.gl;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
  }

  private texQuad(
    x: number, y: number, w: number, h: number,
    u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number,
  ): void {
    if (this.texVertCount + 6 > MAX_VERTICES) return; // pool cap, same as quad()
    const v = this.texVerts;
    let o = this.texVertCount * FLOATS_PER_VERTEX_TEX;
    const put = (px: number, py: number, u: number, vv: number) => {
      v[o++] = px; v[o++] = py; v[o++] = u; v[o++] = vv; v[o++] = r; v[o++] = g; v[o++] = b; v[o++] = a;
    };
    put(x, y, u0, v0); put(x + w, y, u1, v0); put(x + w, y + h, u1, v1);
    put(x, y, u0, v0); put(x + w, y + h, u1, v1); put(x, y + h, u0, v1);
    this.texVertCount += 6;
  }

  /**
   * 9-slice one note rect from the atlas into the textured batch.
   * Returns false when the rect can't be 3×3-sliced (< 3 px — the caller falls back
   * to the code-drawn quad) so nineSliceRect's throw never reaches the render loop.
   */
  private texturedSlice(
    x: number, y: number, w: number, h: number,
    frame: AtlasFrame, r: number, g: number, b: number, a: number,
  ): boolean {
    if (w < 3 || h < 3 || this.texVertCount + 54 > MAX_VERTICES) return false; // 54 = 9 quads × 6 verts
    const atlas = this.atlasSize;
    if (!atlas) return false;
    const quads = nineSliceRect(w, h, frame.slice, frame.w, frame.h);
    const invW = 1 / atlas.w;
    const invH = 1 / atlas.h;
    for (const q of quads) {
      // uv is sprite-local px → atlas-absolute (frame.x + u) → normalized 0..1 (top-left origin,
      // matching dst's y-down space; no Y flip on upload so v=0 is the sprite's top row)
      const u0 = (frame.x + q.uv[0]) * invW;
      const v0 = (frame.y + q.uv[1]) * invH;
      const u1 = (frame.x + q.uv[0] + q.uv[2]) * invW;
      const v1 = (frame.y + q.uv[1] + q.uv[3]) * invH;
      this.texQuad(x + q.dst[0], y + q.dst[1], q.dst[2], q.dst[3], u0, v0, u1, v1, r, g, b, a);
    }
    return true;
  }

  /**
   * Opportunistic atlas load (W2 T22, spec §6.4) — NEVER on the readiness path: the play
   * page fires this right after setting webglReady with its rejection consumed. Idempotent
   * via `atlasInitStarted`: a second call returns the in-flight/settled promise, so state
   * transitions at most once and concurrent calls can't race. Resolves false on any failure
   * → the renderer stays code-drawn permanently; a settled-true atlas is never cleared
   * (no mid-play revert) — the ONE exception is a context loss, where initGL discards the dead
   * texture and re-arms this method for a fresh fetch. Never rejects.
   */
  initAtlas(): Promise<boolean> {
    if (this.atlasInitStarted && this.atlasInitPromise) return this.atlasInitPromise;
    this.atlasInitStarted = true;
    this.atlasInitPromise = this.loadAtlas();
    return this.atlasInitPromise;
  }

  private async loadAtlas(): Promise<boolean> {
    // A9: bounded wait — a stuck/blocked atlas route must not hang the opportunistic load.
    // Both fetches share ONE AbortController; a 5 s window aborts them and the renderer
    // commits the permanent "fallback" state (code-drawn path, set once per session).
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000); // A9: bounded wait
    try {
      const res = await fetch("/atlas/atlas.json", { signal: controller.signal });
      if (!res.ok) throw new Error(`atlas.json HTTP ${res.status}`);
      const json = (await res.json()) as AtlasJson;
      const tapRect = json.frames[TAP_FRAME];
      const holdRect = json.frames[HOLD_FRAME];
      const size = json.meta?.size;
      if (!tapRect || !holdRect || !size?.width || !size?.height) throw new Error("atlas.json missing required frames");
      const imgRes = await fetch("/atlas/sprites.png", { signal: controller.signal });
      if (!imgRes.ok) throw new Error(`sprites.png HTTP ${imgRes.status}`);
      const bitmap = await createImageBitmap(await imgRes.blob());
      const gl = this.gl;
      const tex = gl.createTexture();
      if (!tex) {
        bitmap.close();
        throw new Error("texture creation failed");
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      bitmap.close();
      if (this.disposed) {
        // Strict Mode remount can dispose the renderer mid-load — don't leak the texture
        gl.deleteTexture(tex);
        this._atlasState = "fallback"; // aborted by teardown — permanent code-drawn path
        return false;
      }
      // commit LAST: success-only state transition (atlasFrames/atlasTex are never cleared)
      this.atlasTex = tex;
      this.atlasSize = { w: size.width, h: size.height };
      this.atlasFrames = { tap: withSlice(tapRect), hold: withSlice(holdRect) };
      this._atlasState = "loaded";
      return true;
    } catch {
      this._atlasState = "fallback"; // permanent for the session — code-drawn path (W2)
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  dispose(): void {
    // called from the /play effect cleanup — React Strict Mode remounts effects in dev,
    // so program/buffer must be released or every remount leaks GPU resources
    this.disposed = true;
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.texBuffer);
    this.gl.deleteProgram(this.texProgram);
    if (this.atlasTex) this.gl.deleteTexture(this.atlasTex);
  }
}

// Pending notes draw as before; hit/missed notes draw a fading flash (flashAlpha) at the
// y frozen on their transition frame, culled once the fade completes.
// Fallback for an absent/unparsable --you token — kept byte-equal to the §6.1 value
// so the rendered color matches even when getComputedStyle cannot resolve the var
const NOTE_COLOR: readonly [number, number, number] = [92 / 255, 225 / 255, 230 / 255]; // --you cyan #5CE1E6
// missed flash — matches the HUD MISS red rgb(255, 92, 92)
const MISS_FLASH_COLOR: readonly [number, number, number] = [1, 92 / 255, 92 / 255];

function hexToRgb(raw: string): readonly [number, number, number] | null {
  const m = raw.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// 25% of sprite dims as 9-slice guides (PLAN T21 packer note) — atlas.json carries no
// `sliced` metadata for these frames, so margins derive from frame size at load
function withSlice(f: AtlasFrameRect): AtlasFrame {
  const lx = Math.round(f.w * 0.25);
  const ly = Math.round(f.h * 0.25);
  return { ...f, slice: { left: lx, top: ly, right: lx, bottom: ly } };
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = `#version 300 es
    in vec2 a_pos; in vec4 a_col; uniform vec2 u_res; out vec4 v_col;
    void main() {
      vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_col = a_col;
    }`;
  const fs = `#version 300 es
    precision mediump float; in vec4 v_col; out vec4 outColor;
    void main() { outColor = v_col; }`;
  // u_res must be set on resize — store via gl.getUniformLocation in constructor resize()
  return compileAndLink(gl, vs, fs);
}

// textured pipeline (W2 T22): samples the atlas at 9-slice UVs and multiplies by the
// per-vertex tint (runtime tint only, no pre-recolored copies — §6.5.2). layout(location=)
// pins attrib slots so both programs' pointer setup stays explicit.
function buildTextureProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = `#version 300 es
    layout(location = 0) in vec2 a_pos; layout(location = 1) in vec2 a_uv; layout(location = 2) in vec4 a_col;
    uniform vec2 u_res; out vec2 v_uv; out vec4 v_col;
    void main() {
      vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_uv = a_uv; v_col = a_col;
    }`;
  const fs = `#version 300 es
    precision highp float; // atlas UVs span ~1800 px — mediump quantizes sampling
    uniform sampler2D u_tex; in vec2 v_uv; in vec4 v_col; out vec4 outColor;
    void main() { outColor = texture(u_tex, v_uv) * v_col; }`;
  return compileAndLink(gl, vs, fs);
}

function compileAndLink(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
