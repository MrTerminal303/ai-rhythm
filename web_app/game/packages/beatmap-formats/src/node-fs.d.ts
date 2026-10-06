// ponytail: no @types/node (T14 adds no deps) — script-context shim so the
// test's fixture loader typechecks. Upgrade path: replace with
// `"@types/node": "26.6.4"` devDep (already pinned in apps/web) when allowed.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}
