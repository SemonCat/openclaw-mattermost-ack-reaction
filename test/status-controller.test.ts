import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostStatusController } from "../src/status-controller.js";
import type { MattermostFetchLike } from "../src/mattermost-client.js";

type ReactionCall = { method: string; emoji: string };

function createFetch(params: { failAdd?: string; failRemove?: string } = {}) {
  const calls: ReactionCall[] = [];
  const fetchImpl: MattermostFetchLike = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({ id: "bot-1" }), { status: 200 });
    }
    if (url.endsWith("/reactions")) {
      const emoji = String(JSON.parse(String(init?.body)).emoji_name);
      calls.push({ method: "POST", emoji });
      return new Response("{}", { status: params.failAdd === emoji ? 500 : 200 });
    }
    if (init?.method === "DELETE") {
      const emoji = decodeURIComponent(url.split("/").at(-1) ?? "");
      calls.push({ method: "DELETE", emoji });
      return new Response("{}", { status: params.failRemove === emoji ? 500 : 200 });
    }
    throw new Error(`unexpected request ${String(init?.method)} ${url}`);
  }) as unknown as MattermostFetchLike;
  return { calls, fetchImpl };
}

function createController(fetchImpl: MattermostFetchLike, onLog = vi.fn()) {
  return {
    controller: createMattermostStatusController({
      baseUrl: "https://chat.example.com",
      botToken: `token-${Math.random()}`,
      postId: "post-1",
      initialEmojiName: "eyes",
      timeoutMs: 2000,
      fetchImpl,
      timing: {
        debounceMs: 0,
        stallSoftMs: 60_000,
        stallHardMs: 120_000,
      },
      onLog,
    }),
    onLog,
  };
}

async function flushDebounce() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("createMattermostStatusController", () => {
  afterEach(() => vi.useRealTimers());

  it("removes only tracked transients and leaves the success reaction", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = createFetch();
    const { controller } = createController(fetchImpl);
    controller.setQueued();
    await flushDebounce();
    controller.setThinking();
    await flushDebounce();
    controller.setTool("exec");
    await flushDebounce();

    await controller.setDone();

    expect(calls.filter((call) => call.method === "POST").map((call) => call.emoji)).toEqual([
      "brain",
      "computer",
      "white_check_mark",
    ]);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.emoji)).toEqual([
      "eyes",
      "brain",
      "computer",
    ]);
    expect(calls).not.toContainEqual({ method: "DELETE", emoji: "rocket" });
    expect(calls).not.toContainEqual({ method: "DELETE", emoji: "white_check_mark" });
  });

  it("uses moyai for a hard inactivity stall instead of a warning", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = createFetch();
    const { controller } = createController(fetchImpl);
    controller.setQueued();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toContainEqual({ method: "POST", emoji: "moyai" });
    expect(calls).not.toContainEqual({ method: "POST", emoji: "warning" });
  });

  it("removes transients and leaves only the error reaction on failure", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = createFetch();
    const { controller } = createController(fetchImpl);
    controller.setQueued();
    await flushDebounce();
    controller.setThinking();
    await flushDebounce();

    await controller.setError();

    expect(calls).toContainEqual({ method: "POST", emoji: "x" });
    expect(calls).toContainEqual({ method: "DELETE", emoji: "eyes" });
    expect(calls).toContainEqual({ method: "DELETE", emoji: "brain" });
    expect(calls).not.toContainEqual({ method: "DELETE", emoji: "x" });
  });

  it("does not track or later remove a reaction whose add failed", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = createFetch({ failAdd: "brain" });
    const onLog = vi.fn();
    const { controller } = createController(fetchImpl, onLog);
    controller.setQueued();
    await flushDebounce();
    controller.setThinking();
    await flushDebounce();

    await controller.setDone();

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("failed to add"));
    expect(calls).not.toContainEqual({ method: "DELETE", emoji: "brain" });
    expect(calls).toContainEqual({ method: "DELETE", emoji: "eyes" });
  });

  it("logs remove failures without rejecting terminal cleanup", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = createFetch({ failRemove: "eyes" });
    const onLog = vi.fn();
    const { controller } = createController(fetchImpl, onLog);
    controller.setQueued();
    await flushDebounce();

    await expect(controller.setDone()).resolves.toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("failed to remove"));
  });
});
