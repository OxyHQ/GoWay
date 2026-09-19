/**
 * The process configuration, parsed ONCE at module load.
 *
 * Every environment variable this backend reads is declared here and nowhere
 * else. `process.env` is not consulted from a route, a repository or a
 * middleware — the point of a single parse is that a misconfigured deployment
 * fails at startup with every problem named at once, instead of at the first
 * request that happens to reach the one code path that reads the bad value.
 *
 * `parseConfig` takes its source as an argument (defaulting to `process.env`)
 * so a test can hand it a fake environment without mutating the real one.
 * Mutating `process.env` in a test leaks into every other test in the same
 * worker, and the leak is order-dependent, which is the worst shape a flake can
 * take.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Before the parse below, and therefore before anything can import a parsed
// value. A `.env` file is a developer convenience only: in ECS every variable
// arrives from the task definition and there is no file to find, so a missing
// one is not an error.
loadDotenv();

/** What a parser reads. `process.env` satisfies it; so does a plain object. */
export type EnvironmentSource = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Combinators. A shell exports an EMPTY string for a variable set to nothing,
// which zod sees as a present value that fails `.min(1)` — so every optional
// field folds `''` back to `undefined` first, and a `.default()` can apply.
// ---------------------------------------------------------------------------

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const integerFromEnv = (fallback: number, { minimum = 1, maximum = 65535 } = {}) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().int().min(minimum).max(maximum).default(fallback));

const httpOrigin = z
  .string()
  .trim()
  // `new URL` rather than zod's own URL check: the accepted spelling of that
  // check moved between zod 3 and 4, and this one cannot move under us.
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      /^\/*$/.test(url.pathname) &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, 'must be an http(s) origin without credentials, path, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

/** A comma- or whitespace-separated origin list, empty by default. */
const originList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}, z.array(httpOrigin));

/**
 * A postgres connection string.
 *
 * Checked for SHAPE only — that it is a URL with a postgres scheme and a
 * database name. Whether the server answers is a startup question
 * (`connectPostgres`), not a parse question, and pretending otherwise here
 * would put a network round trip inside a module load.
 */
const postgresUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.pathname.replace(/^\//, '').length > 0
    );
  }, 'must be postgres://…/<database>');

// pino's own level names, plus `silent`, which pino accepts and which is what a
// test suite or a noisy one-shot task wants. Restated here rather than imported
// from pino so a bad LOG_LEVEL fails in the ONE configuration parse alongside
// everything else, instead of throwing later inside the logger constructor.
const LOG_LEVELS = ['silent', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const schema = z.object({
  nodeEnv: z.preprocess(
    emptyAsUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  port: integerFromEnv(3000),
  databaseUrl: postgresUrl,
  databasePoolMax: integerFromEnv(10, { maximum: 1000 }),
  databaseIdleTimeoutSeconds: integerFromEnv(30, { maximum: 86_400 }),
  databaseConnectTimeoutSeconds: integerFromEnv(10, { maximum: 3600 }),
  corsAppOrigins: originList,
  oxyApiUrl: z.preprocess(emptyAsUndefined, httpOrigin.default('https://api.oxy.so')),
  logLevel: z.preprocess(emptyAsUndefined, z.enum(LOG_LEVELS).optional()),
});

/** The parsed configuration. */
export type Config = Readonly<z.infer<typeof schema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

/**
 * Parse `source` into a {@link Config}.
 *
 * @throws {Error} Naming every variable that failed, not just the first. A
 *   deployment with three bad values should take one round trip to fix, not
 *   three.
 */
export function parseConfig(source: EnvironmentSource = process.env): Config {
  const result = schema.safeParse({
    nodeEnv: source.NODE_ENV,
    port: source.PORT,
    databaseUrl: source.DATABASE_URL,
    databasePoolMax: source.DATABASE_POOL_MAX,
    databaseIdleTimeoutSeconds: source.DATABASE_IDLE_TIMEOUT_SECONDS,
    databaseConnectTimeoutSeconds: source.DATABASE_CONNECT_TIMEOUT_SECONDS,
    corsAppOrigins: source.CORS_APP_ORIGINS,
    oxyApiUrl: source.OXY_API_URL,
    logLevel: source.LOG_LEVEL,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid backend configuration:\n${problems}\n\n` +
        'Copy packages/backend/.env.example to packages/backend/.env and fill it in. ' +
        'A local database comes from: docker compose -f docker-compose.postgres.yml up -d --wait postgres',
    );
  }

  const parsed = result.data;
  return {
    ...parsed,
    isProduction: parsed.nodeEnv === 'production',
    isTest: parsed.nodeEnv === 'test',
  };
}

/**
 * The one parse for this process.
 *
 * Module-level on purpose: importing anything that reads configuration is what
 * proves the configuration is valid, so there is no window in which a half-
 * configured process is already serving.
 */
export const config: Config = parseConfig();
