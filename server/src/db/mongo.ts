/**
 * MongoDB connection.
 *
 * Persistence is optional: nothing here runs unless `MONGODB_URI` is set.
 * The same code path serves a local `mongod`, the compose `mongo` service and
 * MongoDB Atlas - only the URI differs.
 */
import { setServers } from 'node:dns';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';

const DEFAULT_DB_NAME = 'quiz-shop';

export interface Database {
  client: MongoClient;
  db: Db;
  /** True while a round trip to the server succeeds. */
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Overrides the database named in the URI path. */
  dbName?: string;
  /** How long to wait for a reachable server before giving up. */
  serverSelectionTimeoutMs?: number;
  /**
   * Resolvers for SRV/TXT lookups. `dns.setServers` affects `dns.resolve*`
   * only - ordinary hostname lookups (the AI providers) still go through the
   * operating system.
   */
  dnsServers?: string[];
}

/**
 * Connect and verify the connection with a ping, so a wrong URI, a bad
 * password or an Atlas IP allowlist miss fails at startup rather than on the
 * first question.
 */
export async function connectDatabase(uri: string, options: ConnectOptions = {}): Promise<Database> {
  if (options.dnsServers?.length) setServers(options.dnsServers);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 10_000,
    appName: 'ai-browser-assistant',
  });

  await client.connect();
  // `client.db()` with no name uses the database in the URI path, if any.
  const db = options.dbName ? client.db(options.dbName) : client.db(dbNameFromUri(uri));

  try {
    await db.command({ ping: 1 });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  return {
    client,
    db,
    async ping() {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}

/** The database named in the URI path, e.g. `mongodb+srv://host/quiz-shop?...`. */
export function dbNameFromUri(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  const name = match?.[1] ? decodeURIComponent(match[1]) : '';
  return name || DEFAULT_DB_NAME;
}
