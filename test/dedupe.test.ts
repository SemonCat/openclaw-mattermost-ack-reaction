import { describe, expect, it } from "vitest";
import { createDedupeCache } from "../src/dedupe.js";

describe("createDedupeCache", () => {
  it("claims a key the first time and rejects it while still within TTL", () => {
    const cache = createDedupeCache({ ttlMs: 1000 });
    expect(cache.tryClaim("a")).toBe(true);
    expect(cache.tryClaim("a")).toBe(false);
    expect(cache.tryClaim("a")).toBe(false);
  });

  it("allows reclaiming a key again after the TTL expires", () => {
    let now = 0;
    const cache = createDedupeCache({ ttlMs: 1000, now: () => now });
    expect(cache.tryClaim("a")).toBe(true);
    now = 999;
    expect(cache.tryClaim("a")).toBe(false);
    now = 1001;
    expect(cache.tryClaim("a")).toBe(true);
  });

  it("allows immediate reclaim after release", () => {
    const cache = createDedupeCache({ ttlMs: 60_000 });
    expect(cache.tryClaim("a")).toBe(true);
    cache.release("a");
    expect(cache.tryClaim("a")).toBe(true);
  });

  it("releasing an unclaimed key is a harmless no-op", () => {
    const cache = createDedupeCache();
    expect(() => cache.release("never-claimed")).not.toThrow();
  });

  it("bounds memory by evicting the oldest entry once maxEntries is reached", () => {
    let now = 0;
    const cache = createDedupeCache({ ttlMs: 60_000, maxEntries: 2, now: () => now });
    expect(cache.tryClaim("a")).toBe(true);
    now = 1;
    expect(cache.tryClaim("b")).toBe(true);
    now = 2;
    // Cache is full; claiming "c" must evict the oldest ("a") to stay bounded.
    expect(cache.tryClaim("c")).toBe(true);
    now = 3;
    expect(cache.tryClaim("a")).toBe(true);
  });

  it("keeps different keys independent", () => {
    const cache = createDedupeCache();
    expect(cache.tryClaim("a")).toBe(true);
    expect(cache.tryClaim("b")).toBe(true);
  });
});
