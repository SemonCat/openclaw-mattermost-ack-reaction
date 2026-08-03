import { describe, expect, it } from "vitest";
import { resolveScopeDecision } from "../src/scope.js";

describe("resolveScopeDecision", () => {
  it("reacts for scope 'all'", () => {
    expect(resolveScopeDecision("all")).toEqual({ action: "react" });
  });

  it("is case/whitespace insensitive for 'all'", () => {
    expect(resolveScopeDecision("  ALL  ")).toEqual({ action: "react" });
  });

  it("skips for 'off'", () => {
    expect(resolveScopeDecision("off")).toEqual({ action: "skip" });
  });

  it("skips for 'none'", () => {
    expect(resolveScopeDecision("none")).toEqual({ action: "skip" });
  });

  it("defaults to group-mentions when scope is undefined, and reports it unsupported", () => {
    expect(resolveScopeDecision(undefined)).toEqual({
      action: "unsupported",
      scope: "group-mentions",
    });
  });

  for (const narrowScope of ["group-mentions", "group-all", "direct"]) {
    it(`reports "${narrowScope}" as unsupported rather than guessing`, () => {
      expect(resolveScopeDecision(narrowScope)).toEqual({
        action: "unsupported",
        scope: narrowScope,
      });
    });
  }

  it("reports unrecognized scope values as unsupported instead of throwing", () => {
    expect(resolveScopeDecision("something-new")).toEqual({
      action: "unsupported",
      scope: "something-new",
    });
  });
});
