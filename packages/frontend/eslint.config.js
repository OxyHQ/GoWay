/**
 * The frontend's MINIMAL ESLint config. Biome (`biome.jsonc` at the repository
 * root) lints and formats everything; this file holds only the rules Biome has
 * no equivalent for, so `expo lint` runs nothing Biome already runs.
 *
 *  - `expo/no-env-var-destructuring` and `expo/no-dynamic-env-var`: Metro
 *    inlines `process.env.EXPO_PUBLIC_*` only when it is read as a literal
 *    member expression. A destructured or computed read is silently left
 *    undefined in the bundle. `expo/use-dom-exports` keeps `'use dom'`
 *    components exporting the one default component Expo can mount.
 *  - The React Compiler rules of `eslint-plugin-react-hooks` 7 (`immutability`,
 *    `refs`, `purity`, ...). `app.config.js` turns the compiler on, and a
 *    component that breaks one of these is silently left uncompiled.
 *    `rules-of-hooks` and `exhaustive-deps` are NOT here: Biome's
 *    `useHookAtTopLevel` and `useExhaustiveDependencies` run them.
 */
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expoPlugin = require('eslint-plugin-expo');
const reactHooks = require('eslint-plugin-react-hooks');

const reactCompilerRules = Object.fromEntries(
  Object.entries(reactHooks.configs.flat.recommended.rules).filter(
    ([name]) => name !== 'react-hooks/rules-of-hooks' && name !== 'react-hooks/exhaustive-deps',
  ),
);

module.exports = defineConfig([
  { ignores: ['dist/*', 'web-build/*', 'public/*', '.expo/*'] },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo: expoPlugin, 'react-hooks': reactHooks },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      'expo/use-dom-exports': 'error',
      ...reactCompilerRules,
    },
  },
]);
