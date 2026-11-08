import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.PNG_PACKAGE_JSON ?? import.meta.url);
const { PNG } = require('pngjs');
const luminance = (c) =>
  c
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (y + 0.05) / (x + 0.05);
};
const distance = (a, b) => Math.sqrt(a.reduce((n, v, i) => n + (v - b[i]) ** 2, 0));
const results = [];
for (const mode of ['light', 'dark']) {
  const root = `${process.env.CONTRAST_ROOT ?? 'packages/frontend/.local/issue-663/browser-runs'}/contrast-${mode}`;
  const data = JSON.parse(readFileSync(`${root}/contrast-targets.json`));
  for (const scene of data.scenes) {
    const backingImage = PNG.sync.read(readFileSync(`${root}/${scene.name}-backing.png`));
    const actualImage = PNG.sync.read(readFileSync(`${root}/${scene.name}.png`));
    for (const t of scene.targets) {
      const declared = t.color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
      const r = t.rect;
      const mask = [];
      let nearest = Infinity,
        paintedForeground,
        foregroundPoint;
      for (let y = Math.ceil(r.y); y < Math.floor(r.bottom); y++)
        for (let x = Math.ceil(r.x); x < Math.floor(r.right); x++) {
          const i = (y * backingImage.width + x) * 4;
          const backing = Array.from(backingImage.data.subarray(i, i + 3)),
            actual = Array.from(actualImage.data.subarray(i, i + 3));
          if (distance(actual, backing) < 5) continue;
          const vector = declared.map((v, j) => v - backing[j]);
          const length = vector.reduce((s, v) => s + v * v, 0);
          const coverage = vector.reduce((s, v, j) => s + v * (actual[j] - backing[j]), 0) / length;
          const expected = backing.map((v, j) => v + coverage * vector[j]);
          if (coverage < 0.05 || coverage > 1.05 || distance(actual, expected) > 3) continue;
          mask.push({ backing, x, y });
          const delta = distance(actual, declared);
          if (delta < nearest) {
            nearest = delta;
            paintedForeground = actual;
            foregroundPoint = { x, y };
          }
        }
      if (!mask.length) throw new Error(`No painted text pixels: ${mode}/${scene.name}/${t.text}`);
      let minimum = Infinity,
        worstBacking,
        worstPoint;
      for (const p of mask) {
        const ratio = contrast(paintedForeground, p.backing);
        if (ratio < minimum) {
          minimum = ratio;
          worstBacking = p.backing;
          worstPoint = { x: p.x, y: p.y };
        }
      }
      results.push({
        mode,
        scene: scene.name,
        text: t.text,
        declared,
        paintedForeground,
        foregroundPoint,
        matchDelta: nearest,
        minimum,
        worstBacking,
        worstPoint,
        glyphPixels: mask.length,
      });
    }
  }
}
writeFileSync(
  process.env.CONTRAST_OUTPUT ??
    'packages/frontend/.local/issue-663/browser-runs/contrast-results.json',
  JSON.stringify(results, null, 2),
);
for (const mode of ['light', 'dark'])
  for (const scene of ['land', 'sea']) {
    const rows = results.filter((r) => r.mode === mode && r.scene === scene);
    console.log(
      mode,
      scene,
      rows.length,
      'minimum',
      Math.min(...rows.map((r) => r.minimum)),
      'maxMatchDelta',
      Math.max(...rows.map((r) => r.matchDelta)),
      rows.filter((r) => r.minimum < 4.5).map((r) => ({ text: r.text, ratio: r.minimum })),
    );
  }
