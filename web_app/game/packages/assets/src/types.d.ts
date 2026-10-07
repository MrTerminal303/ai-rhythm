// ponytail: no @types/node / @types/pngjs (T21 adds only pngjs@7.0.0) —
// script-context shims so build-atlas.ts typechecks, mirroring
// packages/beatmap-formats/src/node-fs.d.ts. Upgrade path: replace with
// `"@types/node": "26.6.4"` + `@types/pngjs` devDeps when allowed.

declare module "node:fs" {
  export function mkdirSync(path: string, options: { recursive?: boolean }): string | undefined;
  export function readdirSync(path: string, options: { recursive: true }): string[];
  export function readFileSync(path: string): Uint8Array;
  export function statSync(path: string): { isFile(): boolean };
  export function writeFileSync(path: string, data: Uint8Array | string): void;
}
declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
declare module "pngjs" {
  export class PNG {
    constructor(options: { width: number; height: number });
    width: number;
    height: number;
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
      write(png: PNG): Uint8Array;
    };
  }
}
declare var process: { exit(code?: number): never };
