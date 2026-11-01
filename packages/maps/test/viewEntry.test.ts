import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const src = (file: string) => join(root, 'src', file);

/** Find value re-exports without depending on formatting or declaration order. */
function valueExports(file: string): Map<string, string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const exports = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) exports.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return exports;
}

/** Follow value imports within this package, including side-effect imports. */
function sourceGraph(entry: string, web: boolean): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      const suffixes = web ? ['.web.ts', '.web.tsx', '.ts', '.tsx'] : ['.ts', '.tsx'];
      const target = suffixes.map((suffix) => `${base}${suffix}`).find(existsSync);
      if (target) visit(target);
    }
  };
  visit(src(entry));
  return seen;
}

describe('map view entry', () => {
  for (const [entry, platformRoot] of [
    ['view.ts', 'index.ts'],
    ['view.web.ts', 'index.web.ts'],
  ] as const) {
    it(`${entry} re-exports the same map and markers as ${platformRoot}`, () => {
      const lean = valueExports(src(entry));
      const full = valueExports(src(platformRoot));
      expect([...lean.keys()].sort()).toEqual(['DefaultMapMarker', 'MapView', 'Markers']);
      expect(lean.get('MapView')).toBe(full.get('MapView'));
      expect(lean.get('Markers')).toBe(full.get('Markers'));
      expect(lean.get('DefaultMapMarker')).toBe(
        valueExports(src('shared-exports.ts')).get('DefaultMapMarker'),
      );
    });
  }

  it('resolves the published web and native entry conditions', () => {
    for (const [condition, file] of [
      ['browser', 'view.web.js'],
      ['react-native', 'view.js'],
    ] as const) {
      const result = execFileSync(
        'node',
        [
          `--conditions=${condition}`,
          '--input-type=module',
          '-e',
          "console.log(import.meta.resolve('@goway.to/maps/view'))",
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(new URL(result.trim()).pathname).toBe(join(root, 'dist', file));
    }
  });

  it('keeps the map implementation while excluding unused component graphs', () => {
    for (const [entry, web, map] of [
      ['view.ts', false, 'MapView.tsx'],
      ['view.web.ts', true, 'MapView.web.tsx'],
    ] as const) {
      const graph = sourceGraph(entry, web);
      expect(graph.has(src(map))).toBe(true);
      for (const name of [
        'GeoJSONSource',
        'RasterDEMSource',
        'Layer',
        'UserLocation',
        'MapPlugin',
      ]) {
        expect(graph.has(src(`${name}${web ? '.web' : ''}.tsx`))).toBe(false);
      }
    }
    expect(readFileSync(src('MapView.web.tsx'), 'utf8')).toContain(
      "import 'maplibre-gl/dist/maplibre-gl.css'",
    );
  });

  it('typechecks a consumer of both public entries', () => {
    execFileSync(
      'bun',
      [
        'x',
        'tsc',
        '--noEmit',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'bundler',
        '--lib',
        'ES2022,DOM',
        join(import.meta.dir, 'fixtures', 'view-consumer.ts'),
      ],
      { cwd: root, stdio: 'pipe' },
    );
  });
});
