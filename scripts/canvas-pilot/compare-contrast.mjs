import { readFileSync, writeFileSync } from 'node:fs';
const before = JSON.parse(readFileSync(process.env.CONTRAST_BEFORE, 'utf8'));
const after = JSON.parse(readFileSync(process.env.CONTRAST_AFTER, 'utf8'));
if (before.length !== after.length) throw new Error('Contrast sample count changed');
const records = after.map((sample, index) => {
  const previous = before[index];
  for (const key of ['mode', 'scene', 'text']) {
    if (sample[key] !== previous[key]) throw new Error(`Sample ${index} changed ${key}`);
  }
  // Text is not an identifier: multiple "Closed" labels occur in one scene.
  return {
    targetIndex: index,
    mode: sample.mode,
    scene: sample.scene,
    text: sample.text,
    before: previous.minimum,
    after: sample.minimum,
    delta: sample.minimum - previous.minimum,
    foregroundChanged:
      JSON.stringify(sample.paintedForeground) !== JSON.stringify(previous.paintedForeground),
    backingChanged: JSON.stringify(sample.worstBacking) !== JSON.stringify(previous.worstBacking),
  };
});
writeFileSync(process.env.CONTRAST_DELTA, `${JSON.stringify(records, null, 2)}\n`);
console.log(
  JSON.stringify({
    samples: records.length,
    worsened: records.filter((r) => r.delta < -1e-9).length,
    changedNeighbors: records.filter(
      (r) =>
        r.text !== '[search placeholder]' &&
        (Math.abs(r.delta) > 1e-9 || r.foregroundChanged || r.backingChanged),
    ).length,
  }),
);
