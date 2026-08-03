import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

type HookHandler = (event: any, ctx: any) => Promise<unknown> | unknown;
type FetchInput = Parameters<typeof fetch>[0];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mattermost-ack-reaction plugin", () => {
  const hooks: Record<string, HookHandler> = {};
  const warn = vi.fn();
  const info = vi.fn();
  let configFile: Record<string, unknown> = {};
  const originalToken = process.env.MATTERMOST_BOT_TOKEN;
  const originalUrl = process.env.MATTERMOST_URL;

  const api = {
    id: "mattermost-ack-reaction",
    name: "Mattermost Ack Reaction",
    pluginConfig: {},
    config: {},
    runtime: {
      config: {
        current: () => configFile,
      },
    },
    logger: { info, warn, debug: vi.fn(), error: vi.fn() },
    on: vi.fn((hookName: string, handler: HookHandler) => {
      hooks[hookName] = handler;
    }),
  };

  function defaultConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      messages: { ackReaction: "👀", ackReactionScope: "all" },
      channels: {
        mattermost: { botToken: "mm-token", baseUrl: "https://chat.example.com" },
      },
      ...overrides,
    };
  }

  function installFetchMock(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      if (url.endsWith("/reactions")) {
        return jsonResponse(200, { user_id: "bot-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function dispatch(event: Record<string, unknown>, ctx: Record<string, unknown>) {
    const handler = hooks.message_received;
    if (!handler) {
      throw new Error("message_received hook was not registered");
    }
    return handler(event, ctx);
  }

  function dispatchHook(
    hookName: string,
    event: Record<string, unknown>,
    ctx: Record<string, unknown> = {},
  ) {
    const handler = hooks[hookName];
    if (!handler) {
      throw new Error(`${hookName} hook was not registered`);
    }
    return handler(event, ctx);
  }

  function installLifecycleFetchMock() {
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      if (url.endsWith("/reactions") && init?.method === "POST") {
        return jsonResponse(200, { ok: true });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${String(init?.method)} request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function reactionPosts(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/reactions") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { post_id: string; emoji_name: string });
  }

  async function flushPromises() {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    configFile = defaultConfig();
    delete process.env.MATTERMOST_BOT_TOKEN;
    delete process.env.MATTERMOST_URL;
    plugin.register(api as unknown as OpenClawPluginApi);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalToken === undefined) {
      delete process.env.MATTERMOST_BOT_TOKEN;
    } else {
      process.env.MATTERMOST_BOT_TOKEN = originalToken;
    }
    if (originalUrl === undefined) {
      delete process.env.MATTERMOST_URL;
    } else {
      process.env.MATTERMOST_URL = originalUrl;
    }
  });

  it("ignores messages from channels other than mattermost", async () => {
    const fetchMock = installFetchMock();
    await dispatch({ messageId: "post-1" }, { channelId: "slack", accountId: "default" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores events with no messageId on either the event or context", async () => {
    const fetchMock = installFetchMock();
    await dispatch({}, { channelId: "mattermost", accountId: "default" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds the ack reaction for scope 'all'", async () => {
    // Unique token/baseUrl so this test's bot-user-id lookup can never be
    // served from another test's cached value in mattermost-client.ts's
    // module-level cache, keeping the exact call-count assertion below
    // independent of test execution order.
    configFile = defaultConfig({
      channels: {
        mattermost: {
          botToken: `mm-token-${Math.random()}`,
          baseUrl: "https://scope-all.example.com",
        },
      },
    });
    const fetchMock = installFetchMock();
    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reactionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reactions"));
    expect(reactionCall).toBeDefined();
    const [, init] = reactionCall as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      user_id: "bot-1",
      post_id: "post-1",
      emoji_name: "eyes",
    });
  });

  it("falls back to ctx.messageId when event.messageId is absent", async () => {
    const fetchMock = installFetchMock();
    await dispatch({}, { channelId: "mattermost", accountId: "default", messageId: "post-9" });
    const reactionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reactions"));
    const [, init] = reactionCall as [string, RequestInit];
    expect(JSON.parse(String(init.body)).post_id).toBe("post-9");
  });

  for (const scope of ["off", "none"]) {
    it(`skips silently for ackReactionScope "${scope}"`, async () => {
      configFile = defaultConfig({ messages: { ackReaction: "👀", ackReactionScope: scope } });
      const fetchMock = installFetchMock();
      await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it("skips and logs once (not per-message) for an unsupported scope like the default group-mentions", async () => {
    configFile = defaultConfig({ messages: { ackReaction: "👀" } });
    const fetchMock = installFetchMock();
    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });
    await dispatch({ messageId: "post-2" }, { channelId: "mattermost", accountId: "default" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("group-mentions");
  });

  it("suppresses a duplicate REST write when the same message is replayed", async () => {
    const fetchMock = installFetchMock();
    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });
    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });

    // Only the first dispatch should have produced a reactions POST (plus its users/me lookup).
    const reactionCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reactions"));
    expect(reactionCalls).toHaveLength(1);
  });

  it("resolves credentials for the default account from environment variables when config omits them", async () => {
    configFile = defaultConfig({ channels: { mattermost: {} } });
    process.env.MATTERMOST_BOT_TOKEN = "env-token";
    process.env.MATTERMOST_URL = "https://env.example.com";
    const fetchMock = installFetchMock();

    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });

    const usersMeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/users/me"));
    expect(usersMeCall?.[0]).toBe("https://env.example.com/api/v4/users/me");
  });

  it("logs and skips when Mattermost credentials cannot be resolved", async () => {
    configFile = defaultConfig({ channels: { mattermost: {} } });
    const fetchMock = installFetchMock();

    await dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("missing Mattermost baseUrl/botToken");
  });

  it("logs a warning but never throws when the Mattermost API call fails", async () => {
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/users/me")) {
        return jsonResponse(200, { id: "bot-1" });
      }
      return new Response("server error", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("failed to add ack reaction");
  });

  it("never throws even if reading the runtime config throws", async () => {
    const brokenApi = {
      ...api,
      runtime: {
        config: {
          current: () => {
            throw new Error("config unavailable");
          },
        },
      },
      on: vi.fn((hookName: string, handler: HookHandler) => {
        hooks[hookName] = handler;
      }),
    };
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    plugin.register(brokenApi as unknown as OpenClawPluginApi);
    installFetchMock();

    await expect(
      dispatch({ messageId: "post-1" }, { channelId: "mattermost", accountId: "default" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("unexpected error");
  });

  it("correlates concurrent runIds through model, tool, success, and failure cleanup", async () => {
    vi.useFakeTimers();
    configFile = defaultConfig({
      channels: {
        mattermost: {
          botToken: `lifecycle-token-${Math.random()}`,
          baseUrl: "https://lifecycle.example.com",
        },
      },
    });
    const fetchMock = installLifecycleFetchMock();

    await dispatch(
      { messageId: "post-1", runId: "run-1" },
      { channelId: "mattermost", accountId: "default", runId: "run-1" },
    );
    await dispatch(
      { messageId: "post-2", runId: "run-2" },
      { channelId: "mattermost", accountId: "default", runId: "run-2" },
    );
    await dispatchHook("model_call_started", { runId: "run-1" }, { runId: "run-1" });
    await dispatchHook("model_call_started", { runId: "run-2" }, { runId: "run-2" });
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook(
      "before_tool_call",
      { runId: "run-2", toolName: "web_search", params: {} },
      { runId: "run-2", toolName: "web_search" },
    );
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook("agent_end", { runId: "run-1", success: true, messages: [] }, { runId: "run-1" });
    await dispatchHook("agent_end", { runId: "run-2", success: false, messages: [] }, { runId: "run-2" });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    const posts = reactionPosts(fetchMock);
    expect(posts.filter((post) => post.post_id === "post-1").map((post) => post.emoji_name)).toEqual([
      "eyes",
      "brain",
      "white_check_mark",
    ]);
    expect(posts.filter((post) => post.post_id === "post-2").map((post) => post.emoji_name)).toEqual([
      "eyes",
      "brain",
      "globe_with_meridians",
      "x",
    ]);
    const deleteUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url));
    expect(deleteUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/posts/post-1/reactions/eyes"),
        expect.stringContaining("/posts/post-1/reactions/brain"),
        expect.stringContaining("/posts/post-2/reactions/eyes"),
        expect.stringContaining("/posts/post-2/reactions/brain"),
        expect.stringContaining("/posts/post-2/reactions/globe_with_meridians"),
      ]),
    );
  });

  it("correlates lifecycle hooks by sessionKey when message_received has no runId", async () => {
    vi.useFakeTimers();
    const fetchMock = installLifecycleFetchMock();
    const sessionKey = "agent:main:mattermost:channel:town-square:thread:root-post";

    await dispatch(
      { messageId: "post-session", sessionKey },
      { channelId: "mattermost", accountId: "default", sessionKey },
    );
    await dispatchHook(
      "model_call_started",
      { runId: "run-session" },
      { runId: "run-session", sessionKey },
    );
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook(
      "agent_end",
      { runId: "run-session", success: true, messages: [] },
      { runId: "run-session", sessionKey },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(reactionPosts(fetchMock).map((post) => post.emoji_name)).toEqual([
      "eyes",
      "brain",
      "white_check_mark",
    ]);
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === "DELETE")
        .map(([url]) => String(url)),
    ).toEqual(expect.arrayContaining([expect.stringContaining("/posts/post-session/reactions/eyes")]));
  });

  it("settles a same-session steered message with the active lifecycle", async () => {
    vi.useFakeTimers();
    const fetchMock = installLifecycleFetchMock();
    const sessionKey = "agent:main:mattermost:channel:town-square:thread:steer-root";

    await dispatch(
      { messageId: "post-active", sessionKey },
      { channelId: "mattermost", accountId: "default", sessionKey },
    );
    await dispatchHook(
      "model_call_started",
      { runId: "run-active" },
      { runId: "run-active", sessionKey },
    );
    await vi.advanceTimersByTimeAsync(700);

    await dispatch(
      { messageId: "post-steered", sessionKey },
      { channelId: "mattermost", accountId: "default", sessionKey },
    );
    await dispatchHook(
      "model_call_started",
      { runId: "run-active" },
      { runId: "run-active", sessionKey },
    );
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook(
      "agent_end",
      { runId: "run-active", success: true, messages: [] },
      { runId: "run-active", sessionKey },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(
      reactionPosts(fetchMock)
        .filter((post) => post.post_id === "post-active")
        .map((post) => post.emoji_name),
    ).toEqual(["eyes", "brain", "white_check_mark"]);
    expect(
      reactionPosts(fetchMock)
        .filter((post) => post.post_id === "post-steered")
        .map((post) => post.emoji_name),
    ).toEqual(["eyes", "brain", "white_check_mark"]);
  });

  it("keeps ack-only behavior when status reactions are disabled", async () => {
    vi.useFakeTimers();
    configFile = defaultConfig({
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
        statusReactions: { enabled: false },
      },
      channels: {
        mattermost: {
          botToken: `disabled-token-${Math.random()}`,
          baseUrl: "https://disabled.example.com",
        },
      },
    });
    const fetchMock = installLifecycleFetchMock();

    await dispatch(
      { messageId: "post-disabled", runId: "run-disabled" },
      { channelId: "mattermost", accountId: "default", runId: "run-disabled" },
    );
    await dispatchHook("model_call_started", { runId: "run-disabled" }, { runId: "run-disabled" });
    await dispatchHook(
      "agent_end",
      { runId: "run-disabled", success: true, messages: [] },
      { runId: "run-disabled" },
    );
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(reactionPosts(fetchMock)).toHaveLength(1);
    expect(reactionPosts(fetchMock)[0]).toEqual(
      expect.objectContaining({ post_id: "post-disabled", emoji_name: "eyes" }),
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("cancels a transient agent_end when a retry model call resumes", async () => {
    vi.useFakeTimers();
    const fetchMock = installLifecycleFetchMock();
    await dispatch(
      { messageId: "post-retry", runId: "run-retry" },
      { channelId: "mattermost", accountId: "default", runId: "run-retry" },
    );
    await dispatchHook("agent_end", { runId: "run-retry", success: false, messages: [] }, { runId: "run-retry" });
    await vi.advanceTimersByTimeAsync(500);
    await dispatchHook("model_call_started", { runId: "run-retry" }, { runId: "run-retry" });
    await vi.advanceTimersByTimeAsync(1200);
    await flushPromises();

    expect(reactionPosts(fetchMock).map((post) => post.emoji_name)).toEqual(["eyes", "brain"]);

    await dispatchHook("agent_end", { runId: "run-retry", success: true, messages: [] }, { runId: "run-retry" });
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(reactionPosts(fetchMock).map((post) => post.emoji_name)).toContain("white_check_mark");
  });

  it("orders correlated compaction before resumed thinking and terminal success", async () => {
    vi.useFakeTimers();
    const fetchMock = installLifecycleFetchMock();
    await dispatch(
      { messageId: "post-compact", runId: "run-compact" },
      { channelId: "mattermost", accountId: "default", runId: "run-compact" },
    );

    await dispatchHook("before_compaction", { messageCount: 10 }, { runId: "run-compact" });
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook(
      "after_compaction",
      { messageCount: 4, compactedCount: 1 },
      { runId: "run-compact" },
    );
    await vi.advanceTimersByTimeAsync(700);
    await dispatchHook(
      "agent_end",
      { runId: "run-compact", success: true, messages: [] },
      { runId: "run-compact" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(reactionPosts(fetchMock).map((post) => post.emoji_name)).toEqual([
      "eyes",
      "clamp",
      "brain",
      "white_check_mark",
    ]);
  });
});
