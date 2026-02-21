type IdleWaitResult = {
  ok: boolean;
  reason: "idle" | "aborted" | "timeout";
  sequence: number;
};

type IdleWaiter = {
  afterSequence: number;
  resolve: (result: IdleWaitResult) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

const sessionIdleSequence = new Map<string, number>();
const sessionIdleWaiters = new Map<string, Set<IdleWaiter>>();

export const getSessionIdleSequence = (sessionId: string): number => {
  return sessionIdleSequence.get(sessionId) ?? 0;
};

const settleWaiter = (sessionId: string, waiter: IdleWaiter, result: IdleWaitResult): void => {
  const waiters = sessionIdleWaiters.get(sessionId);
  if (waiters) {
    waiters.delete(waiter);
    if (waiters.size === 0) {
      sessionIdleWaiters.delete(sessionId);
    }
  }
  if (waiter.signal && waiter.abortListener) {
    waiter.signal.removeEventListener("abort", waiter.abortListener);
  }
  if (waiter.timeoutHandle) {
    clearTimeout(waiter.timeoutHandle);
  }
  waiter.resolve(result);
};

export const markSessionIdle = (sessionId: string): number => {
  const nextSequence = getSessionIdleSequence(sessionId) + 1;
  sessionIdleSequence.set(sessionId, nextSequence);

  const waiters = sessionIdleWaiters.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return nextSequence;
  }

  for (const waiter of Array.from(waiters)) {
    if (nextSequence > waiter.afterSequence) {
      settleWaiter(sessionId, waiter, {
        ok: true,
        reason: "idle",
        sequence: nextSequence,
      });
    }
  }

  return nextSequence;
};

export const waitForSessionIdleSignal = async (opts: {
  sessionId: string;
  afterSequence?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<IdleWaitResult> => {
  const { sessionId, signal } = opts;
  const afterSequence = Number.isFinite(opts.afterSequence)
    ? Number(opts.afterSequence)
    : getSessionIdleSequence(sessionId);

  const current = getSessionIdleSequence(sessionId);
  if (current > afterSequence) {
    return {
      ok: true,
      reason: "idle",
      sequence: current,
    };
  }

  if (signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      sequence: current,
    };
  }

  return new Promise<IdleWaitResult>((resolve) => {
    const waiter: IdleWaiter = {
      afterSequence,
      resolve,
      ...(signal ? { signal } : {}),
    };

    if (signal) {
      const onAbort = (): void => {
        const latest = getSessionIdleSequence(sessionId);
        settleWaiter(sessionId, waiter, {
          ok: false,
          reason: "aborted",
          sequence: latest,
        });
      };
      waiter.abortListener = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutMs = Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Number(opts.timeoutMs))
      : 60_000;
    waiter.timeoutHandle = setTimeout(() => {
      const latest = getSessionIdleSequence(sessionId);
      settleWaiter(sessionId, waiter, {
        ok: false,
        reason: "timeout",
        sequence: latest,
      });
    }, timeoutMs);

    const waiters = sessionIdleWaiters.get(sessionId);
    if (waiters) {
      waiters.add(waiter);
    } else {
      sessionIdleWaiters.set(sessionId, new Set([waiter]));
    }
  });
};
