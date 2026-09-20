/**
 * Dereferencing a sample of what the import wrote, against OpenStreetMap
 * itself.
 *
 * ## Issue #58, in one sentence
 *
 * `places_sources` recorded `way/34633854` as Museu Picasso's provenance, and
 * `way/34633854` is the Empire State Building — an identifier that resolves to
 * SOMETHING looks exactly like one that resolves to the right thing, and no
 * schema constraint, type or review can tell the difference. The only thing
 * that can is asking OpenStreetMap what that identifier is and comparing the
 * answer.
 *
 * So the import does that, on a sample, every time it runs. Twenty-five
 * elements is a few seconds and a handful of requests; a wrong element type, an
 * off-by-one in an id, or a mapping that lost track of which element it was
 * describing shows up on the first one.
 *
 * ## What counts as a match, and why it is not string equality
 *
 * The extract is a snapshot and the API is live, so a name edited between the
 * two is a legitimate difference rather than a defect. A sample element passes
 * when it EXISTS, is not deleted, carries the tag that made it a POI, and
 * carries our name under `name` or under any of its `name:*` keys. A single
 * mismatch is reported and tolerated; {@link MAX_MISMATCH_RATIO} of the sample
 * mismatching is the import writing the wrong ids, and fails the run.
 *
 * A DELETED or absent element fails immediately and is not part of the ratio:
 * it means the id does not denote anything at all, which is the #58 shape.
 */

import type { ImportedPlace } from './placeRecord';

/** The read-only API. Anonymous, rate-limited, and asked for a handful of elements. */
const OSM_API = 'https://api.openstreetmap.org/api/0.6';

/** Above this fraction of the sample disagreeing, the ids are wrong rather than stale. */
export const MAX_MISMATCH_RATIO = 0.2;

/** Politeness, and enough to stay far below any per-minute limit. */
const DELAY_MILLISECONDS = 200;

/** One element's verdict. */
export interface ProvenanceCheck {
  sourceId: string;
  /** The name GoWay wrote. */
  expected: string;
  /** What OpenStreetMap calls it now, or `null` when it has no name. */
  actual: string | null;
  status: 'match' | 'name-differs' | 'missing';
}

export interface ProvenanceReport {
  checked: ProvenanceCheck[];
  matched: number;
  nameDiffers: number;
  missing: number;
}

/** Every name the live element carries, lower-cased for comparison. */
function liveNames(tags: Record<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(tags)) {
    if (key !== 'name' && !key.startsWith('name:') && key !== 'alt_name' && key !== 'old_name') {
      continue;
    }
    for (const part of value.split(';')) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed.length > 0) names.add(trimmed);
    }
  }
  return names;
}

/** Every name GoWay holds for this place, lower-cased. */
function heldNames(place: ImportedPlace): string[] {
  return [place.name, ...place.names.map((name) => name.name)].map((name) => name.toLowerCase());
}

/**
 * Check `sample` against the live API.
 *
 * Sequential and slow on purpose: this is twenty-five requests at the end of an
 * import that took minutes, and a burst against a volunteer-run API to save
 * four seconds would be rude.
 */
export async function verifyProvenance(
  sample: readonly ImportedPlace[],
  fetchElement: (sourceId: string) => Promise<Record<string, string> | null> = fetchOsmTags,
): Promise<ProvenanceReport> {
  const checked: ProvenanceCheck[] = [];

  for (const place of sample) {
    const tags = await fetchElement(place.sourceId);
    if (tags === null) {
      checked.push({ sourceId: place.sourceId, expected: place.name, actual: null, status: 'missing' });
      continue;
    }
    const live = liveNames(tags);
    const matched = heldNames(place).some((name) => live.has(name));
    checked.push({
      sourceId: place.sourceId,
      expected: place.name,
      actual: tags.name ?? null,
      status: matched ? 'match' : 'name-differs',
    });
  }

  return {
    checked,
    matched: checked.filter((check) => check.status === 'match').length,
    nameDiffers: checked.filter((check) => check.status === 'name-differs').length,
    missing: checked.filter((check) => check.status === 'missing').length,
  };
}

/**
 * Whether a report is good enough to let the import claim success.
 *
 * A missing element is fatal on its own: it means an identifier GoWay published
 * as provenance denotes nothing.
 */
export function provenanceHolds(report: ProvenanceReport): boolean {
  if (report.checked.length === 0) return true;
  if (report.missing > 0) return false;
  return report.nameDiffers / report.checked.length <= MAX_MISMATCH_RATIO;
}

/** The live element's tags, or `null` when it does not exist or has been deleted. */
async function fetchOsmTags(sourceId: string): Promise<Record<string, string> | null> {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MILLISECONDS));
  const response = await fetch(`${OSM_API}/${sourceId}.json`, {
    headers: { accept: 'application/json', 'user-agent': 'GoWay POI import (https://goway.to)' },
  });
  // 404 is "no such element", 410 is "deleted". Both mean the id denotes
  // nothing today, which is the failure this check exists for.
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    throw new Error(`OpenStreetMap answered ${response.status} for ${sourceId}.`);
  }
  const body = (await response.json()) as { elements?: { tags?: Record<string, string> }[] };
  const element = body.elements?.[0];
  if (!element) return null;
  return element.tags ?? {};
}

/**
 * An evenly spread sample of what a run emitted.
 *
 * Evenly spread rather than the first N: the first thousand places in an
 * extract are all nodes from one corner of the country, and a way/relation
 * mapping bug — which is where an element-type mistake actually lives — would
 * never appear in them.
 */
export function sampleEvenly<T>(items: readonly T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const step = items.length / size;
  const sample: T[] = [];
  for (let index = 0; index < size; index += 1) {
    sample.push(items[Math.floor(index * step)] as T);
  }
  return sample;
}
