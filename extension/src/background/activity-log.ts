/**
 * The activity log behind the monitoring page.
 *
 * A bounded ring buffer in `chrome.storage.local`. It records what was asked,
 * what came back and how long it took, so a site that is not being handled can
 * be diagnosed without attaching a debugger. Nothing here is ever transmitted;
 * clearing it is one click in the options page.
 */
import { ACTIVITY_LOG_STORAGE_KEY, LOG_LIMIT_BOUNDS } from '../shared/constants';
import type { ActivityEntry, ActivityStats } from '../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest question and answer text kept, so the log cannot grow unbounded. */
const TEXT_LIMIT = 500;

export async function readLog(): Promise<ActivityEntry[]> {
  const stored = await chrome.storage.local.get(ACTIVITY_LOG_STORAGE_KEY);
  const value = stored[ACTIVITY_LOG_STORAGE_KEY];
  return Array.isArray(value) ? (value as ActivityEntry[]) : [];
}

async function writeLog(entries: ActivityEntry[]): Promise<void> {
  await chrome.storage.local.set({ [ACTIVITY_LOG_STORAGE_KEY]: entries });
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.round(limit), LOG_LIMIT_BOUNDS.min), LOG_LIMIT_BOUNDS.max);
}

function trim(value: string): string {
  return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
}

/** Append an entry, newest first, dropping the oldest beyond `limit`. */
export async function append(
  entry: Omit<ActivityEntry, 'id'> & { id?: string },
  limit: number,
): Promise<ActivityEntry> {
  const complete: ActivityEntry = {
    ...entry,
    id: entry.id ?? `${entry.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    question: trim(entry.question),
    answer: trim(entry.answer),
  };

  const entries = await readLog();
  entries.unshift(complete);
  await writeLog(entries.slice(0, clampLimit(limit)));
  return complete;
}

/**
 * Update the entry for a question once the content script reports what
 * happened to the answer on the page. Only the most recent entry for that
 * fingerprint is touched.
 */
export async function recordOutcome(
  fingerprint: string,
  outcome: ActivityEntry['outcome'],
): Promise<void> {
  const entries = await readLog();
  const index = entries.findIndex((entry) => entry.fingerprint === fingerprint);
  if (index === -1) return;

  const existing = entries[index];
  if (!existing) return;

  entries[index] = { ...existing, outcome };
  await writeLog(entries);
}

export async function list(limit?: number): Promise<ActivityEntry[]> {
  const entries = await readLog();
  return typeof limit === 'number' ? entries.slice(0, limit) : entries;
}

export async function clear(): Promise<void> {
  await chrome.storage.local.remove(ACTIVITY_LOG_STORAGE_KEY);
}

export async function stats(now: number = Date.now()): Promise<ActivityStats> {
  const entries = await readLog();
  const counts = new Map<string, number>();
  let today = 0;
  let errors = 0;
  let cached = 0;

  for (const entry of entries) {
    if (entry.outcome === 'error') {
      errors += 1;
      continue;
    }
    if (now - entry.at < DAY_MS) today += 1;
    if (entry.outcome === 'cached') cached += 1;
    counts.set(entry.origin, (counts.get(entry.origin) ?? 0) + 1);
  }

  return {
    total: entries.filter((entry) => entry.outcome !== 'error').length,
    today,
    errors,
    cached,
    lastAt: entries[0]?.at ?? null,
    byOrigin: [...counts.entries()]
      .map(([origin, count]) => ({ origin, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
