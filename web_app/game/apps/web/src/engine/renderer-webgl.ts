import { KEY_COUNT, type Beatmap } from "@airhythm/shared";
import type { NoteState, Renderer } from "./types.js";

const SCROLL_PX_PER_MS = 0.5; // presentation-only constant; log any change in DECISIONS.md
const MAX_QUADS = 4096;
const MAX_VERTICES = MAX_QUADS * 6; // 2 triangles × 3 verts per quad
const FLOATS_PER_VERTEX = 6; // x,y,r,g,b,a

// §2.8 position rule as a pure function — exported so engine-render.test.ts pins the
// real production math (y = hitLineY - dt * scrollPxPerMs), not a test re-implementation
export function noteY(noteT: number, chartTimeMs: number, hitLineY: number, scrollPxPerMs: number): number {
  return hitLineY - (noteT - chartTimeMs) * scrollPxPerMs;
}

export class WebGLRenderer implements Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly verts = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
  private vertCount = 0; // counts VERTICES (increments of 6)
  private width = 0;
  private height = 0;
  private hitLineY = 0;
  private readonly noteColor: readonly [number, number, number];
  private laneX: [number, number, number, number] = [0, 0, 0, 0];
  private laneW = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly chart: Beatmap,
  ) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.program = buildProgram(gl);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_pos");
    const col = gl.getAttribLocation(this.program, "a_col");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col, 4, gl.FLOAT, false, 24, 8);
    // lane/note colors use alpha — blending required or colors render wrong
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // §6.1 tokens are the color source of truth: read --you once at construction
    // (canvas inherits it); fallback keeps rendering identical if the var is absent
    this.noteColor = hexToRgb(getComputedStyle(canvas).getPropertyValue("--you")) ?? NOTE_COLOR;
    this.resize();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
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
    const gl = this.gl;
    this.vertCount = 0;
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
    for (const [i, note] of this.chart.notes.entries()) {
      const state = noteStates[i];
      if (state !== "pending") continue; // pooled: only pending/visible drawn
      const y = noteY(note.t, chartTimeMs, this.hitLineY, SCROLL_PX_PER_MS);
      if (y < -40 || y > this.height + 40) continue;
      const x = this.laneX[note.lane]!;
      const c = this.noteColor;
      this.quad(x + 4, y - 14, this.laneW - 8, 28, c[0], c[1], c[2], 1);
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.vertCount * FLOATS_PER_VERTEX));
    gl.drawArrays(gl.TRIANGLES, 0, this.vertCount);
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

  dispose(): void {
    // called from the /play effect cleanup — React Strict Mode remounts effects in dev,
    // so program/buffer must be released or every remount leaks GPU resources
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}

// Only "pending" notes are ever drawn (see guard above); hit/missed flash colors deferred to W2.
// Fallback for an absent/unparsable --you token — kept byte-equal to the §6.1 value
// so the rendered color matches even when getComputedStyle cannot resolve the var
const NOTE_COLOR: readonly [number, number, number] = [92 / 255, 225 / 255, 230 / 255]; // --you cyan #5CE1E6

function hexToRgb(raw: string): readonly [number, number, number] | null {
  const m = raw.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
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
  // u_res must be set on resize — store via gl.getUniformLocation in constructor resize()
  return p;
}
