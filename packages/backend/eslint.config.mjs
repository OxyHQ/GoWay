/**
 * ESLint for the GoWay backend.
 *
 * `dist/**` is ignored EXPLICITLY. eslint 9's flat config does not skip build
 * output on its own, and this package lints `.` rather than `src` (so
 * `server.ts`, `drizzle.config.ts` and `eslint.config.mjs` itself are covered).
 * Without the ignore, the same commit reports a different verdict before and
 * after `bun run build` — a gate whose answer depends on whether somebody
 * happened to build is a gate that gets switched off.
 */

import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'drizzle/**'] },
  js.configs.recommended,
  /**
   * Turns OFF the base rules TypeScript itself owns — `no-undef`, `no-redeclare`
   * and friends — for TypeScript files only. `no-undef` cannot see a type, so it
   * reports the `Express` namespace and `NodeJS` as undefined globals. Scoped to
   * `.ts` deliberately: the rule stays fully armed on plain JavaScript.
   */
  typescript.configs['flat/eslint-recommended'],
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': typescript },
    rules: {
      ...typescript.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': 'error',
      // An `any` is a hole in `strict: true`, and this repository has none yet.
      // Kept an error rather than a warning so the first one has to be argued
      // for in review instead of accumulating in a warning count nobody reads.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
