// Stub for vitest — the real module is a Workers-only virtual module.
// Only the DurableObject base class + namespace type are needed at import time.
export class DurableObject<Env = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ctx!: never;
  env: Env;
  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }
}
export class DurableObjectNamespace {}
export type DurableObjectState = {
  storage: unknown;
};
