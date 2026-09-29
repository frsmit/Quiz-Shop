/**
 * Global pacing between answers.
 *
 * The delay is enforced here rather than in the content script so it holds
 * across every tab: three pages open at once should still produce one answer
 * per interval, not three. Callers await a turn and then proceed.
 */
export interface Pacer {
  /** Resolves when the caller may make its request. */
  take: (delayMs: number) => Promise<void>;
  /** When the next turn becomes available, for the popup countdown. */
  nextAvailableAt: () => number;
  /** Push the next turn back by at least `ms` from now (a provider rate limit). */
  defer: (ms: number) => void;
  reset: () => void;
}

export function createPacer(
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Pacer {
  // The time the next caller is allowed to go. Reserving it synchronously is
  // what stops two concurrent callers from being handed the same slot.
  let nextAt = 0;

  return {
    async take(delayMs) {
      if (delayMs <= 0) {
        nextAt = now();
        return;
      }

      const current = now();
      const slot = Math.max(current, nextAt);
      nextAt = slot + delayMs;

      const wait = slot - current;
      if (wait > 0) await sleep(wait);
    },

    nextAvailableAt() {
      return nextAt;
    },

    defer(ms) {
      nextAt = Math.max(nextAt, now() + ms);
    },

    reset() {
      nextAt = 0;
    },
  };
}
