import type { StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLifecycleStore } from "../src/run-lifecycle-store.js";

function createController(overrides: Partial<StatusReactionController> = {}) {
  return {
    setQueued: vi.fn(),
    setThinking: vi.fn(),
    setTool: vi.fn(),
    setCompacting: vi.fn(),
    cancelPending: vi.fn(),
    setDone: vi.fn(async () => undefined),
    setError: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    restoreInitial: vi.fn(async () => undefined),
    ...overrides,
  } satisfies StatusReactionController;
}

describe("createRunLifecycleStore", () => {
  afterEach(() => vi.useRealTimers());

  it("correlates concurrent runIds without crossing controllers", () => {
    const store = createRunLifecycleStore();
    const first = createController();
    const second = createController();
    store.reserve("run-1");
    store.reserve("run-2");
    store.register("run-1", first);
    store.register("run-2", second);

    store.update("run-2", (controller) => controller.setTool("web_search"));
    store.update("run-1", (controller) => controller.setThinking());

    expect(first.setThinking).toHaveBeenCalledOnce();
    expect(first.setTool).not.toHaveBeenCalled();
    expect(second.setTool).toHaveBeenCalledWith("web_search");
    expect(second.setThinking).not.toHaveBeenCalled();
    store.disposeAll();
  });

  it("buffers lifecycle activity that races controller registration", () => {
    const store = createRunLifecycleStore();
    const controller = createController();
    store.reserve("run-race");
    expect(store.update("run-race", (value) => value.setThinking())).toBe(true);

    store.register("run-race", controller);

    expect(controller.setThinking).toHaveBeenCalledOnce();
    store.disposeAll();
  });

  it("cancels a provisional agent_end when retry activity resumes", async () => {
    vi.useFakeTimers();
    const store = createRunLifecycleStore({ terminalSettleMs: 1000 });
    const controller = createController();
    store.reserve("run-retry");
    store.register("run-retry", controller);

    store.finish("run-retry", false);
    await vi.advanceTimersByTimeAsync(500);
    store.update("run-retry", (value) => value.setThinking());
    await vi.advanceTimersByTimeAsync(1000);

    expect(controller.setError).not.toHaveBeenCalled();
    expect(controller.setThinking).toHaveBeenCalledOnce();

    store.finish("run-retry", true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.setDone).toHaveBeenCalledOnce();
  });

  it("commits success and failure terminal states independently", async () => {
    vi.useFakeTimers();
    const store = createRunLifecycleStore({ terminalSettleMs: 0 });
    const success = createController();
    const failure = createController();
    store.reserve("run-success");
    store.reserve("run-failure");
    store.register("run-success", success);
    store.register("run-failure", failure);

    store.finish("run-success", true);
    store.finish("run-failure", false);
    await vi.advanceTimersByTimeAsync(0);

    expect(success.setDone).toHaveBeenCalledOnce();
    expect(success.setError).not.toHaveBeenCalled();
    expect(failure.setError).toHaveBeenCalledOnce();
    expect(failure.setDone).not.toHaveBeenCalled();
  });

  it("restores only non-terminal stale controllers and drops orphan reservations", async () => {
    vi.useFakeTimers();
    const onStale = vi.fn(async (_runId: string, controller: StatusReactionController) => {
      await controller.restoreInitial();
    });
    const store = createRunLifecycleStore({ ttlMs: 100, onStale });
    const controller = createController();
    store.reserve("run-stale");
    store.register("run-stale", controller);
    store.reserve("run-orphan");

    await vi.advanceTimersByTimeAsync(100);

    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith("run-stale", controller);
    expect(controller.restoreInitial).toHaveBeenCalledOnce();
    expect(store.get("run-stale")).toBeUndefined();
    expect(store.update("run-orphan", (value) => value.setThinking())).toBe(false);
  });

  it("never restores the initial reaction after terminal commitment", async () => {
    vi.useFakeTimers();
    let resolveDone: (() => void) | undefined;
    const controller = createController({
      setDone: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            resolveDone = resolve;
          }),
      ),
    });
    const onStale = vi.fn(async (_runId: string, value: StatusReactionController) => {
      await value.restoreInitial();
    });
    const store = createRunLifecycleStore({ terminalSettleMs: 0, onStale });
    store.reserve("run-terminal");
    store.register("run-terminal", controller);
    store.finish("run-terminal", true);
    await vi.advanceTimersByTimeAsync(0);

    store.disposeAll();

    expect(controller.setDone).toHaveBeenCalledOnce();
    expect(onStale).not.toHaveBeenCalled();
    expect(controller.restoreInitial).not.toHaveBeenCalled();
    resolveDone?.();
  });
});
