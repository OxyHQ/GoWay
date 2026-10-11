/**
 * Every word the settings dialog says exists in every `LABEL_LANGUAGES` language
 * (AGENTS.md), with the label hygiene the capability registry is held to, and
 * every registered feature has its name and description.
 */
import { describe, expect, test } from 'bun:test';
import { LABEL_LANGUAGES, type Labels, localizedLabel } from '@goway.to/sdk';

import { CREDIT_LABELS } from '@/lib/map/creditLabels';
import { MAP_FEATURE_LABELS, MAP_SETTINGS_COPY } from '@/lib/map/mapFeatureLabels';
import { MAP_FEATURES } from '@/lib/map/mapFeatures';
import { MAP_SETTINGS_TRIGGER_LABEL } from '@/lib/map/mapSettingsTriggerLabel';

const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/;

function expectComplete(name: string, labels: Labels) {
  expect(Object.keys(labels).sort(), name).toEqual([...LABEL_LANGUAGES].sort());
  for (const language of LABEL_LANGUAGES) {
    const label = labels[language];
    expect(label.length, `${name}.${language}`).toBeGreaterThan(0);
    expect(label, `${name}.${language}`).toBe(label.trim());
    expect(label, `${name}.${language}`).toBe(label.normalize('NFC'));
    expect(BIDI_CONTROLS.test(label), `${name}.${language}`).toBe(false);
  }
}

describe('map feature labels', () => {
  test('every registered feature has a name and a description in every language', () => {
    for (const feature of MAP_FEATURES) {
      const labels = MAP_FEATURE_LABELS[feature.id];
      expect(labels, feature.id).toBeDefined();
      expectComplete(`${feature.id}.name`, labels.name);
      expectComplete(`${feature.id}.description`, labels.description);
    }
    // And no labels for a feature that is not registered.
    expect(Object.keys(MAP_FEATURE_LABELS).sort()).toEqual(
      MAP_FEATURES.map((feature) => feature.id).sort(),
    );
  });

  test('the panel’s own copy, and the button’s name', () => {
    for (const [key, labels] of Object.entries(MAP_SETTINGS_COPY)) expectComplete(key, labels);
    expectComplete('trigger', MAP_SETTINGS_TRIGGER_LABEL);
    for (const [key, labels] of Object.entries(CREDIT_LABELS))
      expectComplete(`credit.${key}`, labels);
  });

  test('`requires` names the feature in every language', () => {
    for (const language of LABEL_LANGUAGES) {
      expect(MAP_SETTINGS_COPY.requires[language], language).toContain('{feature}');
    }
  });

  test('read with the whole locale', () => {
    expect(localizedLabel(MAP_FEATURE_LABELS.globe.name, 'pt-BR')).toBe('Globo');
    expect(localizedLabel(MAP_FEATURE_LABELS.globe.name, 'es-MX')).toBe('Globo terráqueo');
    expect(localizedLabel(MAP_FEATURE_LABELS.globe.name, 'zh-Hans-CN')).toBe('地球仪');
    expect(localizedLabel(MAP_FEATURE_LABELS.globe.name, 'sv')).toBe('Globe');
  });
});
