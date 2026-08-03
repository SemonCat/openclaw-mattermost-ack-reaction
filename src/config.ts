// Resolves effective Mattermost ack-reaction settings (credentials, emoji,
// scope) from the live OpenClaw runtime config, mirroring the documented
// resolution order without depending on the private @openclaw/mattermost
// extension's internal account-merging code.
//
// Resolution order (see docs/channels/mattermost.md and
// docs/gateway/config-agents.md):
//   botToken / baseUrl : account -> channel -> env (default account only)
//   ackReaction         : account -> channel -> messages.ackReaction -> "👀"
//   ackReactionScope    : account -> channel -> messages.ackReactionScope -> "group-mentions"
//
// This intentionally omits the documented final "agent identity emoji"
// fallback for ackReaction: that requires resolving the agent bound to the
// conversation, which is out of scope for a narrow ack-reaction plugin and
// unnecessary for a deployment (like this one) that sets `messages.ackReaction`
// explicitly.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";

type MattermostNetworkConfig = {
  dangerouslyAllowPrivateNetwork?: boolean;
  allowPrivateNetwork?: boolean;
};

/** Narrow local view of the publicly documented Mattermost account config shape. */
type MattermostAccountConfig = {
  name?: string;
  enabled?: boolean;
  botToken?: unknown;
  baseUrl?: string;
  ackReaction?: string;
  ackReactionScope?: string;
  network?: MattermostNetworkConfig;
};

/** Narrow local view of the publicly documented `channels.mattermost` shape. */
type MattermostChannelConfig = MattermostAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, MattermostAccountConfig>;
};

export type ResolvedMattermostAckSettings = {
  accountId: string;
  enabled: boolean;
  botToken?: string;
  baseUrl?: string;
  /** Raw configured ack reaction value (unicode emoji, `:shortcode:`, or bare name), before Mattermost name normalization. */
  ackReactionRaw: string | undefined;
  scope: string;
  allowPrivateNetwork: boolean;
  /**
   * Resolved from `messages.statusReactions.enabled` (shared, channel-agnostic
   * config also used by bundled channels' own lifecycle status reactions).
   * Only an explicit `false` falls back to ack-only behavior; unset or `true`
   * enables this plugin's lifecycle-reaction upgrade for Mattermost.
   */
  statusReactionsEnabled: boolean;
};

function pickFirstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
}

function readMattermostChannelConfig(config: OpenClawConfig): MattermostChannelConfig {
  const channels = config.channels as Record<string, unknown> | undefined;
  const raw = channels?.mattermost;
  return raw && typeof raw === "object" ? (raw as MattermostChannelConfig) : {};
}

export function resolveMattermostAckSettings(params: {
  config: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMattermostAckSettings {
  const channel = readMattermostChannelConfig(params.config);
  const resolvedAccountId = normalizeAccountId(
    params.accountId ?? channel.defaultAccount ?? DEFAULT_ACCOUNT_ID,
  );
  const account: MattermostAccountConfig = channel.accounts?.[resolvedAccountId] ?? {};

  const channelEnabled = channel.enabled !== false;
  const accountEnabled = account.enabled !== false;

  const allowEnv = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() || undefined : undefined;
  const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() || undefined : undefined;

  const tokenResolution = resolveSecretInputString({
    value: pickFirstDefined(account.botToken, channel.botToken),
    path: `channels.mattermost.accounts.${resolvedAccountId}.botToken`,
    mode: "strict",
  });
  const botToken = tokenResolution.status === "available" ? tokenResolution.value : envToken;

  const baseUrl = normalizeBaseUrl(pickFirstDefined(account.baseUrl, channel.baseUrl, envUrl));

  const ackReactionRaw = pickFirstDefined(
    account.ackReaction,
    channel.ackReaction,
    params.config.messages?.ackReaction,
  );
  const scope =
    pickFirstDefined(
      account.ackReactionScope,
      channel.ackReactionScope,
      params.config.messages?.ackReactionScope,
    ) ?? "group-mentions";

  const allowPrivateNetwork =
    isPrivateNetworkOptInEnabled(account) || isPrivateNetworkOptInEnabled(channel);

  const statusReactionsEnabled = params.config.messages?.statusReactions?.enabled !== false;

  return {
    accountId: resolvedAccountId,
    enabled: channelEnabled && accountEnabled,
    botToken,
    baseUrl,
    ackReactionRaw,
    scope,
    allowPrivateNetwork,
    statusReactionsEnabled,
  };
}
