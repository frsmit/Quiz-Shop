import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const env = (values: Record<string, string>) => loadEnv(values as NodeJS.ProcessEnv);

describe('environment defaults', () => {
  it('binds to loopback and allows the demo page in development', () => {
    const parsed = env({ NODE_ENV: 'development' });
    expect(parsed.HOST).toBe('127.0.0.1');
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual(['chrome-extension://*', 'http://localhost:5173']);
  });

  it('binds to all interfaces and allows only the extension in production', () => {
    const parsed = env({ NODE_ENV: 'production', API_ACCESS_KEY: 'a-long-secret' });
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual(['chrome-extension://*']);
  });

  it('refuses to start in production without an API key', () => {
    expect(() => env({ NODE_ENV: 'production' })).toThrow(/API_ACCESS_KEY: required/);
  });

  it('honours explicit HOST and CORS settings in production', () => {
    const parsed = env({
      NODE_ENV: 'production',
      API_ACCESS_KEY: 'a-long-secret',
      HOST: '127.0.0.1',
      CORS_ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnop, https://app.example.com',
    });
    expect(parsed.HOST).toBe('127.0.0.1');
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual([
      'chrome-extension://abcdefghijklmnop',
      'https://app.example.com',
    ]);
  });

  it('parses the persistence settings', () => {
    const parsed = env({
      MONGODB_URI: 'mongodb://localhost:27017/quiz-shop',
      HISTORY_ENABLED: 'false',
      HISTORY_RETENTION_DAYS: '30',
    });
    expect(parsed.MONGODB_URI).toBe('mongodb://localhost:27017/quiz-shop');
    expect(parsed.HISTORY_ENABLED).toBe(false);
    expect(parsed.HISTORY_RETENTION_DAYS).toBe(30);
  });
});
