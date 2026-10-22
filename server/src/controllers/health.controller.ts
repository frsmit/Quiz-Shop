/**
 * `GET /api/health`
 *
 * Reports which providers have credentials, never what those credentials are,
 * and whether persistence is reachable - never where it is. The options page
 * uses it for its "Test connection" button.
 */
import type { RequestHandler } from 'express';
import type { ProviderRegistry } from '../providers/provider.factory.js';

export interface PersistenceStatus {
  /** Where answers are cached. */
  cache: 'mongodb' | 'memory' | 'off';
  history: boolean;
  /** Absent when MongoDB is not configured. */
  ping?: () => Promise<boolean>;
}

export function healthHandler(
  factory: ProviderRegistry,
  persistence: PersistenceStatus = { cache: 'memory', history: false },
): RequestHandler {
  return async (_req, res) => {
    const descriptors = factory.describe();
    const database = persistence.ping
      ? (await persistence.ping())
        ? 'connected'
        : 'unreachable'
      : 'not_configured';

    res.status(200).json({
      status: database === 'unreachable' ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      activeProvider: factory.activeProvider(),
      providers: descriptors.filter((entry) => entry.configured).map((entry) => entry.id),
      allProviders: descriptors.map(({ id, label, configured, defaultModel }) => ({
        id,
        label,
        configured,
        defaultModel,
      })),
      // Whether a key entered in the extension's settings will be used.
      clientCredentials: factory.acceptsClientKeys(),
      persistence: { database, cache: persistence.cache, history: persistence.history },
    });
  };
}
