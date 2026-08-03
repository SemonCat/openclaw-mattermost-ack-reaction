import { describe, expect, it, vi } from "vitest";
import {
  addAckReaction,
  removeAckReaction,
  type MattermostFetchLike,
} from "../src/mattermost-client.js";

type FetchInput = Parameters<MattermostFetchLike>[0];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("addAckReaction", () => {
  const baseParams = {
    baseUrl: "https://chat.example.com",
    botToken: "mm-token",
    postId: "post-1",
    emojiName: "eyes",
    timeoutMs: 2000,
  };

  it("resolves the bot user id then posts the reaction", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: MattermostFetchLike = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      if (url.endsWith("/reactions")) {
        return jsonResponse(200, { user_id: "bot-1", post_id: "post-1", emoji_name: "eyes" });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as MattermostFetchLike;

    const botToken = `unique-token-${Math.random()}`;
    const result = await addAckReaction({ ...baseParams, fetchImpl, botToken });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://chat.example.com/api/v4/users/me");
    expect(calls[1]?.url).toBe("https://chat.example.com/api/v4/reactions");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      user_id: "bot-1",
      post_id: "post-1",
      emoji_name: "eyes",
    });
    const authHeader = new Headers(calls[1]?.init?.headers).get("authorization");
    expect(authHeader).toBe(`Bearer ${botToken}`);
  });

  it("fails without posting a reaction when /users/me cannot resolve a bot id", async () => {
    const reactionsCalls: unknown[] = [];
    const fetchImpl: MattermostFetchLike = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return jsonResponse(401, { message: "invalid token" });
      }
      reactionsCalls.push(url);
      return jsonResponse(200, {});
    }) as unknown as MattermostFetchLike;

    const result = await addAckReaction({
      ...baseParams,
      fetchImpl,
      botToken: `unique-token-${Math.random()}`,
    });

    expect(result.ok).toBe(false);
    expect(reactionsCalls).toHaveLength(0);
  });

  it("reports a failure result when the reactions endpoint returns a non-2xx status", async () => {
    const fetchImpl: MattermostFetchLike = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      return new Response("post already deleted", { status: 404 });
    }) as unknown as MattermostFetchLike;

    const result = await addAckReaction({
      ...baseParams,
      fetchImpl,
      botToken: `unique-token-${Math.random()}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });

  it("bounds the request with a timeout instead of hanging forever", async () => {
    const hangingFetch: MattermostFetchLike = vi.fn(
      (_input: FetchInput, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    ) as unknown as MattermostFetchLike;

    const result = await addAckReaction({
      ...baseParams,
      fetchImpl: hangingFetch,
      timeoutMs: 20,
      botToken: `unique-token-${Math.random()}`,
    });

    expect(result.ok).toBe(false);
  });

  it("caches the resolved bot user id across calls for the same baseUrl/botToken", async () => {
    let usersMeCalls = 0;
    const token = `unique-token-${Math.random()}`;
    const fetchImpl: MattermostFetchLike = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        usersMeCalls += 1;
        return jsonResponse(200, { id: "bot-1" });
      }
      return jsonResponse(200, {});
    }) as unknown as MattermostFetchLike;

    await addAckReaction({ ...baseParams, fetchImpl, botToken: token });
    await addAckReaction({ ...baseParams, fetchImpl, botToken: token });

    expect(usersMeCalls).toBe(1);
  });

  it("never throws even when the fetch implementation throws synchronously", async () => {
    const throwingFetch: MattermostFetchLike = vi.fn(() => {
      throw new Error("network is down");
    }) as unknown as MattermostFetchLike;

    await expect(
      addAckReaction({ ...baseParams, fetchImpl: throwingFetch, botToken: `unique-${Math.random()}` }),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("removeAckReaction", () => {
  it("deletes only the bot user's exact post/emoji tuple", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: MattermostFetchLike = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot/user" });
      }
      return new Response(null, { status: 204 });
    }) as unknown as MattermostFetchLike;

    const result = await removeAckReaction({
      baseUrl: "https://chat.example.com",
      botToken: `remove-token-${Math.random()}`,
      postId: "post/1",
      emojiName: "+1",
      timeoutMs: 2000,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(calls[1]).toEqual(
      expect.objectContaining({
        url: "https://chat.example.com/api/v4/users/bot%2Fuser/posts/post%2F1/reactions/%2B1",
        init: expect.objectContaining({ method: "DELETE" }),
      }),
    );
  });

  it("returns a failure instead of throwing when deletion fails", async () => {
    const fetchImpl: MattermostFetchLike = vi.fn(async (input) => {
      if (String(input).endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      return new Response("denied", { status: 403 });
    }) as unknown as MattermostFetchLike;

    await expect(
      removeAckReaction({
        baseUrl: "https://chat.example.com",
        botToken: `remove-token-${Math.random()}`,
        postId: "post-1",
        emojiName: "eyes",
        timeoutMs: 2000,
        fetchImpl,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});
