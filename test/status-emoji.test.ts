import { DEFAULT_EMOJIS, resolveToolEmoji } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it } from "vitest";
import { MATTERMOST_STATUS_EMOJIS } from "../src/status-emoji.js";

const emojis = { ...DEFAULT_EMOJIS, ...MATTERMOST_STATUS_EMOJIS };

describe("Mattermost lifecycle emoji mapping", () => {
  it("uses Mattermost names for every lifecycle state", () => {
    expect(MATTERMOST_STATUS_EMOJIS).toEqual({
      thinking: "brain",
      tool: "hammer_and_wrench",
      coding: "computer",
      web: "globe_with_meridians",
      deploy: "flight_departure",
      build: "building_construction",
      concierge: "tipping_hand_person",
      done: "white_check_mark",
      error: "x",
      stallSoft: "hourglass_flowing_sand",
      stallHard: "moyai",
      compacting: "clamp",
    });
  });

  it.each([
    ["exec", "computer"],
    ["web_search", "globe_with_meridians"],
    ["deploy_release", "flight_departure"],
    ["npm_build", "building_construction"],
    ["browser_click", "tipping_hand_person"],
    ["unknown_tool", "hammer_and_wrench"],
  ])("maps tool %s through the public controller categories", (toolName, expected) => {
    expect(resolveToolEmoji(toolName, emojis, MATTERMOST_STATUS_EMOJIS)).toBe(expected);
  });
});
