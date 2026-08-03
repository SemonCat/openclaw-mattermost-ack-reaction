import { describe, expect, it } from "vitest";
import { resolveAckReactionEmoji } from "../src/emoji.js";

describe("resolveAckReactionEmoji", () => {
  it("maps the default 👀 unicode emoji to Mattermost's 'eyes'", () => {
    expect(resolveAckReactionEmoji("👀")).toEqual({ kind: "name", name: "eyes" });
  });

  it("accepts a :shortcode: form", () => {
    expect(resolveAckReactionEmoji(":eyes:")).toEqual({ kind: "name", name: "eyes" });
  });

  it("accepts a bare Mattermost emoji name", () => {
    expect(resolveAckReactionEmoji("eyes")).toEqual({ kind: "name", name: "eyes" });
  });

  it("accepts a :shortcode: wrapping a unicode emoji", () => {
    expect(resolveAckReactionEmoji(":👀:")).toEqual({ kind: "name", name: "eyes" });
  });

  it("maps a small set of other well-known unicode emoji", () => {
    expect(resolveAckReactionEmoji("👍")).toEqual({ kind: "name", name: "+1" });
    expect(resolveAckReactionEmoji("🔥")).toEqual({ kind: "name", name: "fire" });
  });

  it("passes through bare names containing +/- (e.g. +1/-1)", () => {
    expect(resolveAckReactionEmoji("+1")).toEqual({ kind: "name", name: "+1" });
    expect(resolveAckReactionEmoji("-1")).toEqual({ kind: "name", name: "-1" });
  });

  it("trims surrounding whitespace", () => {
    expect(resolveAckReactionEmoji("  eyes  ")).toEqual({ kind: "name", name: "eyes" });
  });

  it("treats an empty string as explicitly disabled", () => {
    expect(resolveAckReactionEmoji("")).toEqual({ kind: "disabled" });
    expect(resolveAckReactionEmoji("   ")).toEqual({ kind: "disabled" });
  });

  it("treats undefined as explicitly disabled", () => {
    expect(resolveAckReactionEmoji(undefined)).toEqual({ kind: "disabled" });
  });

  it("reports an unmapped unicode emoji as unsupported instead of guessing", () => {
    expect(resolveAckReactionEmoji("🤖")).toEqual({ kind: "unsupported", input: "🤖" });
  });

  it("reports a name with invalid characters as unsupported", () => {
    expect(resolveAckReactionEmoji("not a valid name!")).toEqual({
      kind: "unsupported",
      input: "not a valid name!",
    });
  });
});
