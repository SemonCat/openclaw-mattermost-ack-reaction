import type { StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";

type ControllerUpdate = (controller: StatusReactionController) => Promise<void> | void;

type RunEntry = {
  controller?: StatusReactionController;
  pending: ControllerUpdate[];
  staleTimer: ReturnType<typeof setTimeout>;
  terminalTimer?: ReturnType<typeof setTimeout>;
  terminal: boolean;
};

export type RunLifecycleStore = {
  /** Reserves a run before the asynchronous initial reaction request starts. */
  reserve(runId: string): boolean;
  /** Attaches the controller and replays any lifecycle updates that raced the initial request. */
  register(runId: string, controller: StatusReactionController): boolean;
  /** Applies an activity update only to a run previously reserved by this plugin. */
  update(runId: string, update: ControllerUpdate): boolean;
  /** Schedules an irreversible terminal update unless retry activity resumes first. */
  finish(runId: string, success: boolean): boolean;
  /** Drops a reservation after the initial acknowledgement request fails. */
  cancel(runId: string): void;
  get(runId: string): StatusReactionController | undefined;
  disposeAll(): void;
};

export type RunLifecycleStoreOptions = {
  ttlMs?: number;
  terminalSettleMs?: number;
  onStale?: (runId: string, controller: StatusReactionController) => Promise<void> | void;
};

const DEFAULT_TTL_MS = 15 * 60_000;
// `agent_end` is attempt-scoped in some harness paths. A following retry emits
// fresh activity with the same runId and cancels this short terminal window.
export const DEFAULT_TERMINAL_SETTLE_MS = 1_000;

export function createRunLifecycleStore(options?: RunLifecycleStoreOptions): RunLifecycleStore {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const terminalSettleMs = options?.terminalSettleMs ?? DEFAULT_TERMINAL_SETTLE_MS;
  const entries = new Map<string, RunEntry>();

  function runStaleCleanup(runId: string, entry: RunEntry): void {
    if (!entry.terminal && entry.controller && options?.onStale) {
      void Promise.resolve(options.onStale(runId, entry.controller)).catch(() => undefined);
    }
  }

  function armStaleTimer(runId: string, entry: Omit<RunEntry, "staleTimer"> | RunEntry) {
    if ("staleTimer" in entry) {
      clearTimeout(entry.staleTimer);
    }
    const staleTimer = setTimeout(() => {
      const current = entries.get(runId);
      if (!current || current.staleTimer !== staleTimer) {
        return;
      }
      entries.delete(runId);
      if (current.terminalTimer) {
        clearTimeout(current.terminalTimer);
      }
      runStaleCleanup(runId, current);
    }, ttlMs);
    staleTimer.unref?.();
    return staleTimer;
  }

  function invokeUpdate(entry: RunEntry, update: ControllerUpdate): void {
    if (!entry.controller) {
      entry.pending.push(update);
      return;
    }
    void Promise.resolve(update(entry.controller)).catch(() => undefined);
  }

  function commitTerminal(runId: string, entry: RunEntry, success: boolean): void {
    const current = entries.get(runId);
    if (current !== entry || entry.terminal) {
      return;
    }
    entry.terminal = true;
    entry.terminalTimer = undefined;
    clearTimeout(entry.staleTimer);
    const terminalUpdate: ControllerUpdate = (controller) =>
      success ? controller.setDone() : controller.setError();

    if (!entry.controller) {
      entry.pending.push(terminalUpdate);
      entry.staleTimer = armStaleTimer(runId, entry);
      return;
    }

    const terminalPromise = Promise.resolve(terminalUpdate(entry.controller));
    void terminalPromise
      .catch(() => undefined)
      .finally(() => {
        if (entries.get(runId) === entry) {
          entries.delete(runId);
        }
      });
  }

  function clearEntry(runId: string): RunEntry | undefined {
    const entry = entries.get(runId);
    if (!entry) {
      return undefined;
    }
    entries.delete(runId);
    clearTimeout(entry.staleTimer);
    if (entry.terminalTimer) {
      clearTimeout(entry.terminalTimer);
    }
    return entry;
  }

  return {
    reserve(runId) {
      if (!runId || entries.has(runId)) {
        return false;
      }
      const entryWithoutTimer: Omit<RunEntry, "staleTimer"> = {
        pending: [],
        terminal: false,
      };
      const entry: RunEntry = {
        ...entryWithoutTimer,
        staleTimer: armStaleTimer(runId, entryWithoutTimer),
      };
      entries.set(runId, entry);
      return true;
    },
    register(runId, controller) {
      const entry = entries.get(runId);
      if (!entry || entry.controller) {
        return false;
      }
      entry.controller = controller;
      const pending = entry.pending.splice(0);
      const pendingPromises: Promise<void>[] = [];
      for (const update of pending) {
        try {
          pendingPromises.push(Promise.resolve(update(controller)).catch(() => undefined));
        } catch {
          // Lifecycle reactions are observational and must never block a run.
        }
      }
      if (entry.terminal) {
        void Promise.all(pendingPromises).finally(() => {
          if (entries.get(runId) === entry) {
            entries.delete(runId);
            clearTimeout(entry.staleTimer);
          }
        });
      } else {
        entry.staleTimer = armStaleTimer(runId, entry);
      }
      return true;
    },
    update(runId, update) {
      const entry = entries.get(runId);
      if (!entry || entry.terminal) {
        return false;
      }
      if (entry.terminalTimer) {
        clearTimeout(entry.terminalTimer);
        entry.terminalTimer = undefined;
      }
      entry.staleTimer = armStaleTimer(runId, entry);
      invokeUpdate(entry, update);
      return true;
    },
    finish(runId, success) {
      const entry = entries.get(runId);
      if (!entry || entry.terminal) {
        return false;
      }
      if (entry.terminalTimer) {
        clearTimeout(entry.terminalTimer);
      }
      entry.staleTimer = armStaleTimer(runId, entry);
      entry.terminalTimer = setTimeout(() => commitTerminal(runId, entry, success), terminalSettleMs);
      entry.terminalTimer.unref?.();
      return true;
    },
    cancel(runId) {
      clearEntry(runId);
    },
    get(runId) {
      return entries.get(runId)?.controller;
    },
    disposeAll() {
      for (const runId of Array.from(entries.keys())) {
        const entry = clearEntry(runId);
        if (entry) {
          runStaleCleanup(runId, entry);
        }
      }
    },
  };
}
