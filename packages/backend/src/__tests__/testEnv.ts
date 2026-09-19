/**
 * Test environment defaults, applied by IMPORT ORDER.
 *
 * `src/config` parses `process.env` at module load — one parse per process, so
 * that a misconfigured deployment fails at startup rather than at the first
 * request that reads the bad value. The cost of that design is that merely
 * importing anything downstream of it needs a valid environment, so every test
 * file that reaches `src/config` (directly or through the logger, the app, or a
 * route) must import THIS first:
 *
 *     import './testEnv';           // side-effect import, must come first
 *     import { createApp } from '../app';
 *
 * ES modules evaluate their dependencies in import-declaration order, so a
 * side-effect import placed above the others runs before them. Writing the
 * imports the other way round fails, and it fails at load with the
 * configuration error rather than inside a test — which is at least loud.
 *
 * `??=` rather than `=`: a CI job that supplies a REAL database (the `test` job
 * does) must win over these placeholders. Nothing here opens a connection.
 */

process.env.DATABASE_URL ??= 'postgres://goway:goway@127.0.0.1:5440/goway_test';
process.env.CORS_APP_ORIGINS ??= 'http://localhost:8081';
// Keep the suite's output to failures. A `debug` logger would interleave a JSON
// line with every assertion.
process.env.LOG_LEVEL ??= 'silent';

export {};
