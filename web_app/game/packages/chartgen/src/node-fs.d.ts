// ponytail: no @types/node (T17 adds no dep for the test build) — script-context shim
// so the mel-parity test's vector loader typechecks. Upgrade path: replace with
// `"@types/node": "26.6.4"` devDep (already pinned in apps/web) when a later task allows.
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: string): string;
}
