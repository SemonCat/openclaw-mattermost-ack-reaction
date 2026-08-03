// Binds the public `openclaw/plugin-sdk/channel-feedback` status-reaction
// state machine to one Mattermost post, via the same SSRF-guarded REST calls
// `mattermost-client.ts` already uses for the plain ack reaction.
//
// The controller (not this module) is what guarantees "remove every
// transient emoji this plugin added, leave only the terminal one": it tracks
// exactly the emoji names it has itself applied via `setReaction`/`removeReaction`
// and only ever removes those on `setDone`/`setError`. This module's job is
// just to give it a Mattermost-shaped adapter and a Mattermost-safe emoji
// vocabulary.
import {
  createStatusReactionController,
  type StatusReactionAdapter,
  type StatusReactionController,
  type StatusReactionTiming,
} from "openclaw/plugin-sdk/channel-feedback";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveAckReactionEmoji } from "./emoji.js";
import { addAckReaction, removeAckReaction, type MattermostFetchLike } from "./mattermost-client.js";
import { MATTERMOST_STATUS_EMOJIS } from "./status-emoji.js";

export type CreateMattermostStatusControllerParams = {
  baseUrl: string;
  botToken: string;
  postId: string;
  /** The already-resolved Mattermost `emoji_name` used for the initial ack (e.g. "eyes"). */
  initialEmojiName: string;
  timeoutMs: number;
  policy?: SsrFPolicy;
  fetchImpl?: MattermostFetchLike;
  timing?: StatusReactionTiming;
  onLog: (message: string) => void;
};

export function createMattermostStatusController(
  params: CreateMattermostStatusControllerParams,
): StatusReactionController {
  // The caller has already applied `initialEmojiName` via a direct
  // `addAckReaction` call (with its own synchronous error handling) before
  // constructing this controller, so the very first `setReaction` call for
  // that same emoji is a no-op here — it only needs to mark the emoji as
  // controller-tracked, not send a second, redundant REST request.
  let initialAlreadyApplied = false;

  async function applyEmoji(rawEmoji: string, op: "add" | "remove"): Promise<void> {
    const resolution = resolveAckReactionEmoji(rawEmoji);
    if (resolution.kind !== "name") {
      throw new Error(`lifecycle status emoji "${rawEmoji}" could not be mapped to a Mattermost emoji name`);
    }
    const call = op === "add" ? addAckReaction : removeAckReaction;
    const result = await call({
      baseUrl: params.baseUrl,
      botToken: params.botToken,
      postId: params.postId,
      emojiName: resolution.name,
      timeoutMs: params.timeoutMs,
      policy: params.policy,
      fetchImpl: params.fetchImpl,
    });
    if (!result.ok) {
      // Throw so the public controller does not mark a failed add as owned.
      // Its onError path logs and keeps all failures non-blocking.
      throw new Error(
        `failed to ${op} lifecycle reaction "${resolution.name}" on post ${params.postId}: ${result.error}`,
      );
    }
  }

  const adapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      if (!initialAlreadyApplied && emoji === params.initialEmojiName) {
        initialAlreadyApplied = true;
        return;
      }
      await applyEmoji(emoji, "add");
    },
    removeReaction: (emoji) => applyEmoji(emoji, "remove"),
  };

  return createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: params.initialEmojiName,
    emojis: MATTERMOST_STATUS_EMOJIS,
    timing: params.timing,
    onError: (err) => {
      params.onLog(
        `mattermost-ack-reaction: lifecycle status reaction error: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });
}
