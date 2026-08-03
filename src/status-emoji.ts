// Mattermost `emoji_name` values for the lifecycle status-reaction states
// driven by `openclaw/plugin-sdk/channel-feedback`'s `createStatusReactionController`.
//
// The SDK's own `DEFAULT_EMOJIS` are unicode glyphs (🧠, 🛠️, ✅, ❌, ...);
// Mattermost's reaction API takes a short `emoji_name` instead (e.g. "brain",
// "hammer_and_wrench"). These are the canonical gemoji/Slack-compatible short
// names for that same glyph set, except hard stall deliberately uses
// `moyai` (🗿) instead of the warning sign: inactivity is not an error and
// should not look like one.
//
// `queued` is intentionally omitted: the initial reaction stays the
// configured `messages.ackReaction` (default 👀/"eyes"), resolved separately
// by emoji.ts, so this plugin never overrides an operator's explicit choice.
export const MATTERMOST_STATUS_EMOJIS = {
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
} as const;
