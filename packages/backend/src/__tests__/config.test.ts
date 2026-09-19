/**
 * The configuration parser.
 *
 * Every case hands `parseConfig` its OWN source object. Nothing here mutates
 * `process.env` — a mutation leaks into every other test in the same worker and
 * the leak is order-dependent, which is the worst shape a flake can take. That
 * is the entire reason `parseConfig` takes a source argument.
 */

import './testEnv';
import { describe, expect, it } from 'bun:test';
import { parseConfig, type EnvironmentSource } from '../config';

const DATABASE_URL = 'postgres://goway:goway@127.0.0.1:5440/goway_dev';
const MINIMAL: EnvironmentSource = { DATABASE_URL };

describe('parseConfig', () => {
  it('parses a minimal environment and applies every default', () => {
    const config = parseConfig(MINIMAL);
    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.databasePoolMax).toBe(10);
    expect(config.databaseIdleTimeoutSeconds).toBe(30);
    expect(config.databaseConnectTimeoutSeconds).toBe(10);
    expect(config.corsAppOrigins).toEqual([]);
    expect(config.oxyApiUrl).toBe('https://api.oxy.so');
    expect(config.isProduction).toBe(false);
    expect(config.isTest).toBe(false);
  });

  it('refuses an absent DATABASE_URL', () => {
    expect(() => parseConfig({})).toThrow(/databaseUrl/);
  });

  it('refuses a DATABASE_URL that names no database', () => {
    // The shape that connects to the server's default database and migrates it.
    expect(() => parseConfig({ DATABASE_URL: 'postgres://goway:goway@127.0.0.1:5440' })).toThrow(
      /postgres:\/\//,
    );
  });

  it('refuses a non-postgres DATABASE_URL', () => {
    expect(() => parseConfig({ DATABASE_URL: 'mongodb://127.0.0.1:27017/goway' })).toThrow();
  });

  it('treats an empty string as absent so a default can apply', () => {
    // A shell exports an empty string for a variable set to nothing, which zod
    // sees as a present value. Without the preprocessing this throws instead of
    // defaulting.
    const config = parseConfig({ ...MINIMAL, PORT: '', LOG_LEVEL: '', CORS_APP_ORIGINS: '' });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBeUndefined();
    expect(config.corsAppOrigins).toEqual([]);
  });

  it('refuses a port that is not an integer in range', () => {
    expect(() => parseConfig({ ...MINIMAL, PORT: 'http' })).toThrow(/port/);
    expect(() => parseConfig({ ...MINIMAL, PORT: '0' })).toThrow(/port/);
    expect(() => parseConfig({ ...MINIMAL, PORT: '70000' })).toThrow(/port/);
    expect(() => parseConfig({ ...MINIMAL, PORT: '3000.5' })).toThrow(/port/);
  });

  it('splits and normalises the CORS origin list', () => {
    const config = parseConfig({
      ...MINIMAL,
      CORS_APP_ORIGINS: 'http://localhost:8081, https://goway.to/ ,http://localhost:19006',
    });
    expect(config.corsAppOrigins).toEqual([
      'http://localhost:8081',
      'https://goway.to',
      'http://localhost:19006',
    ]);
  });

  it('refuses an origin carrying a path, query or credentials', () => {
    // A value with a path never matches an `Origin` header, so it would be a
    // silently inert allowlist entry rather than an error.
    expect(() => parseConfig({ ...MINIMAL, CORS_APP_ORIGINS: 'https://goway.to/app' })).toThrow();
    expect(() => parseConfig({ ...MINIMAL, CORS_APP_ORIGINS: 'https://goway.to?a=1' })).toThrow();
    expect(() => parseConfig({ ...MINIMAL, CORS_APP_ORIGINS: 'https://u:p@goway.to' })).toThrow();
    expect(() => parseConfig({ ...MINIMAL, CORS_APP_ORIGINS: 'ftp://goway.to' })).toThrow();
  });

  it('reports EVERY invalid variable, not just the first', () => {
    // A deployment with three bad values should take one round trip to fix.
    let message = '';
    try {
      parseConfig({ DATABASE_URL: 'nonsense', PORT: 'nonsense', NODE_ENV: 'staging' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('databaseUrl');
    expect(message).toContain('port');
    expect(message).toContain('nodeEnv');
  });

  it('derives isProduction and isTest from NODE_ENV', () => {
    expect(parseConfig({ ...MINIMAL, NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(parseConfig({ ...MINIMAL, NODE_ENV: 'test' }).isTest).toBe(true);
    expect(parseConfig({ ...MINIMAL, NODE_ENV: 'production' }).isTest).toBe(false);
  });
});
