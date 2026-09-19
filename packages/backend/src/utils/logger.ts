/**
 * The single logging abstraction for the backend: one pino instance, JSON to
 * stdout, with a redaction list that is part of the security surface rather
 * than a nicety.
 *
 * ## Redaction
 *
 * `authorization`, `cookie`, `x-api-key`, `token`, `secret` and `password` are
 * censored wherever they appear as a logged field. The list matters most on the
 * path nobody writes deliberately: `logger.error({ err }, …)` or a request-shaped
 * object serialises headers, and an Oxy session token in an aggregator's index
 * is a credential leak that no code review catches because no line of code asked
 * for it.
 *
 * ## No pino-pretty transport, deliberately
 *
 * A transport is resolved at logger CONSTRUCTION, so wiring `pino-pretty` in for
 * non-production means the process cannot start when the module is missing. The
 * runtime image installs production dependencies only (`bun install --production`
 * in the Dockerfile), so any environment where `NODE_ENV` is not exactly
 * `production` — a one-shot migration task, a shell in the container, a
 * misspelled variable — would crash at boot on a missing dev dependency, and the
 * error would name a log formatter rather than the misconfiguration. JSON is
 * readable enough through `bunx pino-pretty` when a developer wants it.
 *
 * The object satisfies `@oxy.so/db/migrate`'s logger contract
 * (`{ info(message: string): void; debug(message: string): void }`), so it can
 * be handed to `runMigrations` directly.
 */

import pino from 'pino';
import { config } from '../config';

/**
 * Field paths pino censors. Bare names match at any depth; the bracketed and
 * dotted forms cover the header objects pino's own request serialiser emits.
 */
const REDACT_PATHS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'accessToken',
  'refreshToken',
  'apiKey',
  '*.authorization',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
] as const;

export const logger = pino({
  name: 'goway-backend',
  level: config.logLevel ?? (config.isProduction ? 'info' : 'debug'),
  redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** A child logger tagged with a subsystem, for grep-ability in an aggregator. */
export function createLogger(subsystem: string): pino.Logger {
  return logger.child({ subsystem });
}
