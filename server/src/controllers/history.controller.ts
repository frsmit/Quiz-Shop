/**
 * `GET /api/history`, `GET /api/stats`, `POST /api/history/clear`
 *
 * All three sit behind the same API key and rate limit as answering, since
 * history is the user's own data. With persistence off they still answer, with
 * `meta.enabled: false`, so a client can tell "empty" from "not kept".
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { HistoryStore } from '../history/history-store.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.iso.datetime({ offset: true }).optional(),
});

export function listHistoryHandler(history: HistoryStore): RequestHandler {
  return async (req, res) => {
    const { limit, before } = listQuerySchema.parse(req.query);
    const page = await history.list({ limit, before: before ? new Date(before) : undefined });
    res.status(200).json({ data: page, meta: { enabled: history.enabled } });
  };
}

export function statsHandler(history: HistoryStore): RequestHandler {
  return async (_req, res) => {
    res.status(200).json({ data: await history.stats(), meta: { enabled: history.enabled } });
  };
}

export function clearHistoryHandler(history: HistoryStore): RequestHandler {
  return async (_req, res) => {
    const deleted = await history.clear();
    res.status(200).json({ data: { cleared: true, deleted }, meta: { enabled: history.enabled } });
  };
}
