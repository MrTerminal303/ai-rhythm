// ponytail: no @types/node (T17 adds no dep for the test build) — script-context shim
// so the mel-parity test's vector loader typechecks. T25a extends it for the
// flux-v1 parity gate (R19: existsSync + fileURLToPath + process.stderr banner).
// Upgrade path: replace with `"@types/node": "26.6.4"` devDep (already pinned in
// apps/web) when a later task allows.
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: string): string;
  export function existsSync(path: string): boolean;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write(s: string): boolean };
};
