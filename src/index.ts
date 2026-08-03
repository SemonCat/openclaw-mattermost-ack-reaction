// Mattermost Ack Reaction plugin entry point.
//
// Temporary workaround for openclaw/openclaw#99277: the bundled
// @openclaw/mattermost channel does not yet wire `messages.ackReaction` /
// `messages.ackReactionScope` the way Discord, Slack, Telegram, WhatsApp,
// Signal, and Matrix do. This plugin observes `message_received` for the
// Mattermost channel and adds the configured acknowledgement reaction
// directly through the Mattermost REST API.
import { definePluginEntry, ssrfPolicyFromDangerouslyAllowPrivateNetwork, type OpenClawConfig } from "./api.js";
import { resolveMattermostAckSettings } from "./config.js";
import { createDedupeCache } from "./dedupe.js";
import { resolveAckReactionEmoji } from "./emoji.js";
import { addAckReaction } from "./mattermost-client.js";
import { createOnceLogger } from "./once-logger.js";
import { createRunLifecycleStore } from "./run-lifecycle-store.js";
import { resolveScopeDecision } from "./scope.js";
import { createMattermostStatusController } from "./status-controller.js";

const MATTERMOST_CHANNEL_ID = "mattermost";
const DEFAULT_ACK_REACTION = "👀";
const REQUEST_TIMEOUT_MS = 15_000;

function resolveLifecycleKey(
  event: { runId?: string; sessionKey?: string },
  ctx: { runId?: string; sessionKey?: string },
): string | undefined {
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  if (sessionKey) {
    return `session:${sessionKey}`;
  }
  const runId = event.runId ?? ctx.runId;
  return runId ? `run:${runId}` : undefined;
}

export default definePluginEntry({
  id: "mattermost-ack-reaction",
  name: "Mattermost Ack Reaction",
  description:
    "Adds acknowledgement and lifecycle status reactions to accepted inbound Mattermost messages.",
  register(api) {
    const dedupe = createDedupeCache();
    const logOnce = createOnceLogger((message) => api.logger.warn?.(message));
    const lifecycleStore = createRunLifecycleStore({
      onStale: async (_runId, controller) => {
        await controller.restoreInitial();
      },
    });

    api.on("message_received", async (event, ctx) => {
      try {
        if (ctx.channelId !== MATTERMOST_CHANNEL_ID) {
          return;
        }
        const messageId = event.messageId ?? ctx.messageId;
        if (!messageId) {
          return;
        }

        const currentConfig = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
        const settings = resolveMattermostAckSettings({
          config: currentConfig,
          accountId: ctx.accountId,
        });
        if (!settings.enabled) {
          return;
        }

        const scopeDecision = resolveScopeDecision(settings.scope);
        if (scopeDecision.action === "skip") {
          return;
        }
        if (scopeDecision.action === "unsupported") {
          logOnce(
            `scope:${scopeDecision.scope}`,
            `mattermost-ack-reaction: ackReactionScope "${scopeDecision.scope}" is not something the message_received hook proves (no group/mention facts are available here); skipping ack reaction rather than guessing. Set messages.ackReactionScope to "all" for ack reactions on every Mattermost message, or "off"/"none" to disable.`,
          );
          return;
        }

        const emojiResolution = resolveAckReactionEmoji(settings.ackReactionRaw ?? DEFAULT_ACK_REACTION);
        if (emojiResolution.kind === "disabled") {
          return;
        }
        if (emojiResolution.kind === "unsupported") {
          logOnce(
            `emoji:${emojiResolution.input}`,
            `mattermost-ack-reaction: ackReaction "${emojiResolution.input}" could not be mapped to a Mattermost emoji name; skipping ack reaction.`,
          );
          return;
        }

        if (!settings.baseUrl || !settings.botToken) {
          logOnce(
            `creds:${settings.accountId}`,
            `mattermost-ack-reaction: missing Mattermost baseUrl/botToken for account "${settings.accountId}"; skipping ack reaction.`,
          );
          return;
        }

        const dedupeKey = `${settings.accountId}:${messageId}`;
        if (!dedupe.tryClaim(dedupeKey)) {
          return;
        }

        const lifecycleKey = resolveLifecycleKey(event, ctx);
        const lifecycleReserved = Boolean(
          settings.statusReactionsEnabled &&
            lifecycleKey &&
            lifecycleStore.reserve(lifecycleKey),
        );

        const result = await addAckReaction({
          baseUrl: settings.baseUrl,
          botToken: settings.botToken,
          postId: messageId,
          emojiName: emojiResolution.name,
          timeoutMs: REQUEST_TIMEOUT_MS,
          policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(settings.allowPrivateNetwork),
        });
        if (!result.ok) {
          // Release the claim so a legitimate replay can retry after a
          // transient failure; the TTL bound above still caps replay noise.
          dedupe.release(dedupeKey);
          if (lifecycleKey && lifecycleReserved) {
            lifecycleStore.cancel(lifecycleKey);
          }
          api.logger.warn?.(
            `mattermost-ack-reaction: failed to add ack reaction to post ${messageId}: ${result.error}`,
          );
          return;
        }

        if (settings.statusReactionsEnabled && lifecycleKey && lifecycleReserved) {
          const controller = createMattermostStatusController({
            baseUrl: settings.baseUrl,
            botToken: settings.botToken,
            postId: messageId,
            initialEmojiName: emojiResolution.name,
            timeoutMs: REQUEST_TIMEOUT_MS,
            policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(settings.allowPrivateNetwork),
            onLog: (message) => api.logger.warn?.(message),
          });
          controller.setQueued();
          lifecycleStore.register(lifecycleKey, controller);
        } else if (settings.statusReactionsEnabled && !lifecycleKey) {
          logOnce(
            "missing-lifecycle-key",
            "mattermost-ack-reaction: message_received did not provide a sessionKey or runId; keeping ack-only behavior for that message.",
          );
        }
      } catch (err) {
        api.logger.warn?.(
          `mattermost-ack-reaction: unexpected error handling message_received: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    api.on("model_call_started", (event, ctx) => {
      const lifecycleKey = resolveLifecycleKey(event, ctx);
      if (lifecycleKey) {
        lifecycleStore.update(lifecycleKey, (controller) => controller.setThinking());
      }
    });

    api.on("before_tool_call", (event, ctx) => {
      const lifecycleKey = resolveLifecycleKey(event, ctx);
      if (lifecycleKey) {
        lifecycleStore.update(lifecycleKey, (controller) => controller.setTool(event.toolName));
      }
    });

    api.on("before_compaction", (_event, ctx) => {
      const lifecycleKey = resolveLifecycleKey({}, ctx);
      if (lifecycleKey) {
        lifecycleStore.update(lifecycleKey, (controller) => controller.setCompacting());
      }
    });

    api.on("after_compaction", (_event, ctx) => {
      const lifecycleKey = resolveLifecycleKey({}, ctx);
      if (lifecycleKey) {
        lifecycleStore.update(lifecycleKey, (controller) => controller.setThinking());
      }
    });

    api.on("agent_end", (event, ctx) => {
      // Deliberately read lifecycle metadata only. The event's conversation
      // messages and error text are not needed for reaction state.
      const lifecycleKey = resolveLifecycleKey(event, ctx);
      if (lifecycleKey) {
        lifecycleStore.finish(lifecycleKey, event.success);
      }
    });

    api.on("gateway_stop", () => {
      lifecycleStore.disposeAll();
    });
  },
});
