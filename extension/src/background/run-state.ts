/**
 * Pause / resume, and the start delay.
 *
 * Kept in `chrome.storage.local` rather than `sync`: pausing is a decision
 * about this browser right now, not a preference that should follow the
 * profile onto another machine.
 */
import { DEFAULT_RUN_STATE, RUN_STATE_STORAGE_KEY } from '../shared/constants';
import type { ExtensionSettings, RunState, RunStatus } from '../shared/types';

export async function readRunState(): Promise<RunState> {
  const stored = await chrome.storage.local.get(RUN_STATE_STORAGE_KEY);
  const value = stored[RUN_STATE_STORAGE_KEY];
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_RUN_STATE };

  const input = value as Partial<RunState>;
  return {
    paused: typeof input.paused === 'boolean' ? input.paused : DEFAULT_RUN_STATE.paused,
    resumedAt: typeof input.resumedAt === 'number' ? input.resumedAt : DEFAULT_RUN_STATE.resumedAt,
  };
}

async function writeRunState(state: RunState): Promise<RunState> {
  await chrome.storage.local.set({ [RUN_STATE_STORAGE_KEY]: state });
  return state;
}

export function pause(): Promise<RunState> {
  return writeRunState({ paused: true, resumedAt: 0 });
}

/** Resuming restarts the start-delay countdown from now. */
export function resume(now: number = Date.now()): Promise<RunState> {
  return writeRunState({ paused: false, resumedAt: now });
}

/**
 * Make sure a resume timestamp exists.
 *
 * On a fresh install nothing has ever been resumed, so the countdown would
 * have no origin. Stamping it on first use means the start delay is measured
 * from when the extension first had a chance to run.
 */
export async function ensureResumedAt(now: number = Date.now()): Promise<RunState> {
  const state = await readRunState();
  if (state.paused || state.resumedAt > 0) return state;
  return writeRunState({ ...state, resumedAt: now });
}

export interface Readiness {
  status: RunStatus;
  /** Milliseconds until the start delay elapses; 0 once running. */
  startsInMs: number;
}

/** Whether the extension may answer right now, and if not, when it may. */
export function readiness(
  state: RunState,
  settings: ExtensionSettings,
  now: number = Date.now(),
): Readiness {
  if (!settings.autoDetect) return { status: 'disabled', startsInMs: 0 };
  if (state.paused) return { status: 'paused', startsInMs: 0 };

  const readyAt = state.resumedAt + settings.startDelayMs;
  const remaining = readyAt - now;
  if (settings.startDelayMs > 0 && remaining > 0) {
    return { status: 'starting', startsInMs: remaining };
  }
  return { status: 'running', startsInMs: 0 };
}
