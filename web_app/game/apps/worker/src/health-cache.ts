export const HEALTH_TTL_MS = 60_000;
export type HealthCache = { expires: number } | null; // D6: single-entry TTL state (not a Map)

export function isFresh(cache: HealthCache, nowMs: number): boolean {
  return cache !== null && cache.expires > nowMs; // strict > — stale at the exact expiry instant
}

export function nextCache(nowMs: number): HealthCache {
  return { expires: nowMs + HEALTH_TTL_MS };
}
