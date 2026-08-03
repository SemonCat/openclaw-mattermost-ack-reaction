// Normalizes a configured `ackReaction` value into a Mattermost `emoji_name`.
//
// Mattermost's `POST /api/v4/reactions` endpoint takes a short emoji name
// (e.g. "eyes"), not a unicode character. `messages.ackReaction` is shared
// config across channels and is commonly a raw unicode emoji (default "👀"),
// a `:shortcode:`, or an already-bare name. This module accepts all three and
// maps a small, explicit set of unambiguous unicode emoji used elsewhere in
// OpenClaw's own docs/examples to their Mattermost short names. Anything else
// unicode is reported as unsupported rather than guessed.
const MATTERMOST_EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_+-]{1,64}$/;

const UNICODE_EMOJI_TO_MATTERMOST_NAME: Readonly<Record<string, string>> = Object.freeze({
  "\u{1F440}": "eyes", // 👀
  "\u{1F44D}": "+1", // 👍
  "\u{1F44E}": "-1", // 👎
  "✅": "white_check_mark", // ✅
  "❤️": "heart", // ❤️
  "\u{1F389}": "tada", // 🎉
  "\u{1F525}": "fire", // 🔥
  "\u{1F44F}": "clap", // 👏
  "\u{1F680}": "rocket", // 🚀
});

export type AckReactionEmojiResolution =
  | { kind: "disabled" }
  | { kind: "name"; name: string }
  | { kind: "unsupported"; input: string };

function stripSurroundingColons(value: string): string {
  return value.length > 2 && value.startsWith(":") && value.endsWith(":")
    ? value.slice(1, -1)
    : value;
}

export function resolveAckReactionEmoji(rawInput: string | undefined): AckReactionEmojiResolution {
  const trimmed = (rawInput ?? "").trim();
  if (!trimmed) {
    return { kind: "disabled" };
  }
  const candidate = stripSurroundingColons(trimmed);
  const mapped = UNICODE_EMOJI_TO_MATTERMOST_NAME[candidate];
  if (mapped) {
    return { kind: "name", name: mapped };
  }
  if (MATTERMOST_EMOJI_NAME_PATTERN.test(candidate)) {
    return { kind: "name", name: candidate };
  }
  return { kind: "unsupported", input: rawInput ?? "" };
}
