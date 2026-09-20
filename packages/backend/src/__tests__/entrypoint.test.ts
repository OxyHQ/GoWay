import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The image runs `bun packages/backend/dist/server.js`.
 *
 * Bun's entry wrapper treats a CommonJS module's `module.exports` as a
 * `default` export and calls `Bun.serve()` on it. An Express app is not a Bun
 * server config, so an entrypoint that exports ANY value makes the container
 * print its startup banner and then exit 1:
 *
 *     TypeError: Bun.serve() needs either: - A routes object ... - Or a fetch handler
 *
 * That shipped: the `goway` service cycled tasks — start, drain, deregister,
 * start — because `boot()` ran and the throw came afterwards. A healthy-looking
 * log and a dead task.
 *
 * Both tests below are needed. The source check is the fast one a developer
 * sees; the behavioural one is the only thing that proves the RULE rather than
 * its current spelling, because it runs the real Bun against the real shape.
 */
describe('the backend entrypoint', () => {
  // `__dirname`, not `import.meta`: this package compiles as CommonJS, and
  // `import.meta` is a hard typecheck error under that module setting.
  const entry = resolve(__dirname, '../../server.ts');

  it('exports no values, because Bun would try to serve them', () => {
    const source = readFileSync(entry, 'utf8');
    const exportStatements = source
      .split('\n')
      .filter((line) => /^\s*export\s+(?!type\b)/.test(line) || /^\s*module\.exports\s*=/.test(line));

    expect(exportStatements).toEqual([]);
  });

  it('proves the rule: Bun exits non-zero on an entry that exports a value', () => {
    // A positive control. If a future Bun stops auto-serving, this fails and
    // the rule above can be retired deliberately rather than by assumption.
    const dir = mkdtempSync(join(tmpdir(), 'goway-entry-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', type: 'commonjs' }));
      writeFileSync(
        join(dir, 'exporting.js'),
        'Object.defineProperty(exports, "__esModule", { value: true });\nexports.app = { name: "express" };\n',
      );
      writeFileSync(join(dir, 'silent.js'), 'const app = { name: "express" };\nvoid app;\n');

      let exportingFailed = false;
      try {
        execFileSync('bun', ['exporting.js'], { cwd: dir, stdio: 'pipe' });
      } catch {
        exportingFailed = true;
      }
      expect(exportingFailed).toBe(true);

      // …and the same file without exported values runs clean, so the failure
      // above is the exports and not something else about the harness.
      expect(() => execFileSync('bun', ['silent.js'], { cwd: dir, stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
