// Bounded TTL cache that prevents duplicate Mattermost reaction REST calls
// when the same inbound message/hook is replayed (e.g. a Gateway reconnect
// or hook re-dispatch) within a short window.
export type DedupeCache = {
  /** Returns true and claims the key if it was not recently claimed. */
  tryClaim(key: string): boolean;
  /** Releases a claimed key, e.g. after a failed attempt, so it can retry. */
  release(key: string): void;
};

export type DedupeCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 2000;

export function createDedupeCache(options?: DedupeCacheOptions): DedupeCache {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  // Insertion order == expiry order because ttlMs is constant, so eviction
  // can stop at the first non-expired entry instead of scanning every entry.
  const expiresAtByKey = new Map<string, number>();

  function evictExpired(nowMs: number): void {
    for (const [key, expiresAt] of expiresAtByKey) {
      if (expiresAt > nowMs) {
        break;
      }
      expiresAtByKey.delete(key);
    }
  }

  return {
    tryClaim(key: string): boolean {
      const nowMs = now();
      evictExpired(nowMs);
      if (expiresAtByKey.has(key)) {
        return false;
      }
      if (expiresAtByKey.size >= maxEntries) {
        const oldestKey = expiresAtByKey.keys().next().value;
        if (oldestKey !== undefined) {
          expiresAtByKey.delete(oldestKey);
        }
      }
      expiresAtByKey.set(key, nowMs + ttlMs);
      return true;
    },
    release(key: string): void {
      expiresAtByKey.delete(key);
    },
  };
}
