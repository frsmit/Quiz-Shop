/** Thin wrapper over message passing, shared by the options page tabs. */
import { envelope } from '../shared/messages';
import type { UiToWorkerMessage, WorkerResponse } from '../shared/messages';
import type { ActivityEntry, ActivityStats, ExtensionSettings, RuntimeStatus } from '../shared/types';

export async function send(message: UiToWorkerMessage): Promise<WorkerResponse> {
  return (await chrome.runtime.sendMessage(envelope(message))) as WorkerResponse;
}

export async function getSettings(): Promise<ExtensionSettings | null> {
  const response = await send({ kind: 'settings:get' });
  return response.ok && response.kind === 'settings' ? response.settings : null;
}

export async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings | null> {
  const response = await send({ kind: 'settings:save', settings });
  return response.ok && response.kind === 'settings' ? response.settings : null;
}

export async function getStatus(): Promise<RuntimeStatus | null> {
  const response = await send({ kind: 'run:get' });
  return response.ok && response.kind === 'run' ? response.status : null;
}

export async function getLog(limit?: number): Promise<ActivityEntry[]> {
  const response = await send(limit === undefined ? { kind: 'log:list' } : { kind: 'log:list', limit });
  return response.ok && response.kind === 'log' ? response.entries : [];
}

export async function getStats(): Promise<ActivityStats | null> {
  const response = await send({ kind: 'log:stats' });
  return response.ok && response.kind === 'stats' ? response.stats : null;
}

/** `14:02:11` for today, `21 Sep 14:02` for anything older. */
export function formatTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour12: false })
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(at: number | null): string {
  if (at === null) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}
