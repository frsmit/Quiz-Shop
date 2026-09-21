/**
 * `GET /api/health`
 *
 * Reports which providers have credentials, never what those credentials are.
 * The options page uses it for its "Test connection" button.
 */
import type { RequestHandler } from 'express';
import type { ProviderRegistry } from '../providers/provider.factory.js';

export function healthHandler(factory: ProviderRegistry): RequestHandler {
  return (_req, res) => {
    const descriptors = factory.describe();

    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      activeProvider: factory.activeProvider(),
      providers: descriptors.filter((entry) => entry.configured).map((entry) => entry.id),
      allProviders: descriptors.map(({ id, label, configured, defaultModel }) => ({
        id,
        label,
        configured,
        defaultModel,
      })),
    });
  };
}
