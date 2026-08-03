import { describe, expect, it, vi } from "vitest";
import { createOnceLogger } from "../src/once-logger.js";

describe("createOnceLogger", () => {
  it("logs the first occurrence of a key", () => {
    const logFn = vi.fn();
    const logOnce = createOnceLogger(logFn);
    logOnce("k", "message one");
    expect(logFn).toHaveBeenCalledExactlyOnceWith("message one");
  });

  it("suppresses repeat messages for the same key", () => {
    const logFn = vi.fn();
    const logOnce = createOnceLogger(logFn);
    logOnce("k", "message one");
    logOnce("k", "message one again");
    logOnce("k", "message one again");
    expect(logFn).toHaveBeenCalledTimes(1);
  });

  it("logs independently per key", () => {
    const logFn = vi.fn();
    const logOnce = createOnceLogger(logFn);
    logOnce("k1", "one");
    logOnce("k2", "two");
    expect(logFn).toHaveBeenCalledTimes(2);
  });

  it("bounds the number of distinct keys it will ever log", () => {
    const logFn = vi.fn();
    const logOnce = createOnceLogger(logFn, 2);
    logOnce("k1", "one");
    logOnce("k2", "two");
    logOnce("k3", "three");
    expect(logFn).toHaveBeenCalledTimes(2);
  });
});
