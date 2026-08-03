// Minimal, narrowly-scoped Mattermost REST client for adding or removing a
// reaction on one post. Uses OpenClaw's public SSRF-guarded fetch helper instead
// of depending on the private @openclaw/mattermost extension's internal
// client.
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

export type MattermostFetchLike = typeof fetch;

export type AddAckReactionParams = {
  baseUrl: string;
  botToken: string;
  postId: string;
  emojiName: string;
  timeoutMs: number;
  policy?: SsrFPolicy;
  fetchImpl?: MattermostFetchLike;
};

export type AddAckReactionResult = { ok: true } | { ok: false; error: string };

const BOT_USER_ID_CACHE_TTL_MS = 10 * 60_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;

type CachedBotUserId = { userId: string; expiresAt: number };
const botUserIdCache = new Map<string, CachedBotUserId>();

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/api/v4${path}`;
}

async function readJsonBounded<T>(response: Response, maxBytes: number): Promise<T> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(new TextDecoder("utf-8").decode(buffer)) as T;
}

async function drainResponseBody(response: Response): Promise<void> {
  if (response.bodyUsed) {
    return;
  }
  await response.body?.cancel().catch(() => undefined);
}

async function resolveBotUserId(params: {
  baseUrl: string;
  botToken: string;
  timeoutMs: number;
  policy?: SsrFPolicy;
  fetchImpl?: MattermostFetchLike;
  now: () => number;
}): Promise<string | undefined> {
  const cacheKey = `${params.baseUrl}::${params.botToken}`;
  const nowMs = params.now();
  const cached = botUserIdCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.userId;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: apiUrl(params.baseUrl, "/users/me"),
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
    },
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    fetchImpl: params.fetchImpl,
    auditContext: "mattermost-ack-reaction:users-me",
  });
  try {
    if (!response.ok) {
      return undefined;
    }
    const body = await readJsonBounded<{ id?: unknown }>(response, MAX_JSON_RESPONSE_BYTES);
    const userId = typeof body.id === "string" ? body.id.trim() : "";
    if (!userId) {
      return undefined;
    }
    botUserIdCache.set(cacheKey, { userId, expiresAt: nowMs + BOT_USER_ID_CACHE_TTL_MS });
    return userId;
  } finally {
    await drainResponseBody(response);
    await release();
  }
}

/** Adds the given emoji reaction (already a Mattermost `emoji_name`) to a post as the bot user. */
export async function addAckReaction(params: AddAckReactionParams): Promise<AddAckReactionResult> {
  const now = () => Date.now();
  try {
    const userId = await resolveBotUserId({ ...params, now });
    if (!userId) {
      return { ok: false, error: "could not resolve Mattermost bot user id" };
    }

    const { response, release } = await fetchWithSsrFGuard({
      url: apiUrl(params.baseUrl, "/reactions"),
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          post_id: params.postId,
          emoji_name: params.emojiName,
        }),
      },
      timeoutMs: params.timeoutMs,
      policy: params.policy,
      fetchImpl: params.fetchImpl,
      auditContext: "mattermost-ack-reaction:add-reaction",
    });
    try {
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return {
          ok: false,
          error: `Mattermost reaction request failed (${response.status}): ${bodyText.slice(0, 200)}`,
        };
      }
      return { ok: true };
    } finally {
      await drainResponseBody(response);
      await release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Removes the given emoji reaction (already a Mattermost `emoji_name`) from a
 * post, as the bot user. Mattermost scopes reaction removal to a single
 * (post, emoji, user) tuple, so it cannot remove another user's reaction.
 * Callers must still track which emoji tuples this plugin added.
 */
export async function removeAckReaction(params: AddAckReactionParams): Promise<AddAckReactionResult> {
  const now = () => Date.now();
  try {
    const userId = await resolveBotUserId({ ...params, now });
    if (!userId) {
      return { ok: false, error: "could not resolve Mattermost bot user id" };
    }

    const { response, release } = await fetchWithSsrFGuard({
      url: apiUrl(
        params.baseUrl,
        `/users/${encodeURIComponent(userId)}/posts/${encodeURIComponent(params.postId)}/reactions/${encodeURIComponent(params.emojiName)}`,
      ),
      init: {
        method: "DELETE",
        headers: { Authorization: `Bearer ${params.botToken}` },
      },
      timeoutMs: params.timeoutMs,
      policy: params.policy,
      fetchImpl: params.fetchImpl,
      auditContext: "mattermost-ack-reaction:remove-reaction",
    });
    try {
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return {
          ok: false,
          error: `Mattermost reaction delete failed (${response.status}): ${bodyText.slice(0, 200)}`,
        };
      }
      return { ok: true };
    } finally {
      await drainResponseBody(response);
      await release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
