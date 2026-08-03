// Decides whether the configured ack reaction should fire for a given
// `messages.ackReactionScope` value, given what the `message_received` hook
// actually proves.
//
// The hook event/context for Mattermost does not expose group-vs-direct or
// @mention facts (those only exist on the separate `inbound_claim` event), so
// this module deliberately refuses to guess at "group-mentions", "group-all",
// or "direct" behavior. Only "all" (always react) and "off"/"none" (never
// react) are fully honest given the data available here.
export type AckReactionScopeDecision =
  | { action: "react" }
  | { action: "skip" }
  | { action: "unsupported"; scope: string };

export function resolveScopeDecision(rawScope: string | undefined): AckReactionScopeDecision {
  const scope = (rawScope ?? "group-mentions").trim().toLowerCase();
  if (scope === "off" || scope === "none") {
    return { action: "skip" };
  }
  if (scope === "all") {
    return { action: "react" };
  }
  return { action: "unsupported", scope };
}
