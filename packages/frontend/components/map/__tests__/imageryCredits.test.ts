/**
 * The imagery credit on both canvases: which sources are named before and
 * after the coverage and the camera are known, what a failed coverage fetch
 * does, how an engine error over imagery is handled, and the native canvas's
 * settled view (a map opened in satellite and never moved is credited).
 *
 * The rule is over-credit while unsure, never under-credit: a source drawn
 * uncredited breaks its CC BY licence (`docs/MAP_SATELLITE.md`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encodeCoverageTree } from '@/worker/coverageTree.js';
import { cellsTree } from '@/scripts/imagery/cells';
import {
  imageryCreditSources,
  imageryViewOf,
  parseImageryCoverage,
} from '@/lib/map/imageryCoverage';
import { IMAGERY_SOURCES, type ImagerySourceId } from '@/lib/map/imagerySources';
import { IMAGERY_ATTRIBUTION_HREF } from '@/lib/map/provider';
import {
  createNativeCameraReports,
  type NativeRegionChange,
  type NativeViewState,
} from '../nativeCameraReports';
import { mapErrorOutcome } from '../shared';
import {
  forgetImageryCoverage,
  imageryCreditLinks,
  imageryCreditsFor,
  loadImageryCoverage,
} from '../useImageryCredits';

const ALL_SOURCES = Object.keys(IMAGERY_SOURCES) as ImagerySourceId[];

const COVERAGE_DOCUMENT = {
  sets: [
    {
      id: 'icgc-ortofoto-2025',
      tiers: ['detail'],
      minZoom: 13,
      maxZoom: 18,
      sources: ['icgc-ortofoto'],
      bbox: [2.1, 41.3, 2.3, 41.5],
      cells: encodeCoverageTree(cellsTree([{ z: 13, x: 4144, y: 3058 }], 13), 13),
    },
    {
      id: 'worldcover-2021',
      tiers: ['base'],
      minZoom: 8,
      maxZoom: 13,
      sources: ['esa-worldcover-2021'],
      bbox: [0, 40, 4, 43],
      cells: encodeCoverageTree(cellsTree([{ z: 8, x: 129, y: 95 }], 8), 8),
    },
  ],
};
const coverage = parseImageryCoverage(COVERAGE_DOCUMENT);
// Sant Gervasi, inside ICGC's cell 13/4144/3058; Lisbon, in no set's cells.
const SANT_GERVASI = imageryViewOf(16, [2.12, 41.415, 2.14, 41.43]);
const LISBON = imageryViewOf(16, [-9.2, 38.7, -9.1, 38.75]);

describe('which sources are credited', () => {
  test('no coverage document (loading, or its fetch failed): every source', () => {
    expect(imageryCreditSources(null, SANT_GERVASI)).toEqual(ALL_SOURCES);
    expect(imageryCreditSources(null, null)).toEqual(ALL_SOURCES);
  });

  test('no camera yet: every source a published set is made of', () => {
    expect(imageryCreditSources(coverage, null)).toEqual(['icgc-ortofoto', 'esa-worldcover-2021']);
  });

  test('both known: the sources on screen', () => {
    expect(imageryCreditSources(coverage, SANT_GERVASI)).toEqual([
      'icgc-ortofoto',
      'esa-worldcover-2021',
    ]);
    expect(imageryCreditSources(coverage, LISBON)).toEqual([]);
  });

  test('both canvases hand over the same view', () => {
    expect(imageryViewOf(12.5, [1, 2, 3, 4])).toEqual({
      zoom: 12.5,
      west: 1,
      south: 2,
      east: 3,
      north: 4,
    });
  });
});

describe('the credit links', () => {
  test('one per source, each with its own credit, to the attribution page', () => {
    const links = imageryCreditLinks('satellite', ['icgc-ortofoto']);
    expect(links).toEqual([
      { label: IMAGERY_SOURCES['icgc-ortofoto'].credit, href: IMAGERY_ATTRIBUTION_HREF },
    ]);
  });

  test('sources not known yet: every source is named, never none', () => {
    const links = imageryCreditLinks('hybrid', null);
    expect(links.map((link) => link.label)).toEqual(
      ALL_SOURCES.map((id) => IMAGERY_SOURCES[id].credit),
    );
  });

  test('no imagery drawn: nothing', () => {
    expect(imageryCreditLinks(null, null)).toEqual([]);
    expect(imageryCreditLinks(null, ['icgc-ortofoto'])).toEqual([]);
  });
});

describe('the coverage document', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let answer: () => Response | Promise<Response>;
  beforeEach(() => {
    calls = 0;
    forgetImageryCoverage();
    globalThis.fetch = (async () => {
      calls += 1;
      return answer();
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    forgetImageryCoverage();
  });

  const ok = () => Response.json(COVERAGE_DOCUMENT);

  test('a success is kept: one fetch per page', async () => {
    answer = ok;
    expect((await loadImageryCoverage())?.sets).toHaveLength(2);
    expect((await loadImageryCoverage())?.sets).toHaveLength(2);
    expect(calls).toBe(1);
  });

  test('a failure is not kept: the next ask fetches again', async () => {
    answer = () => new Response('down', { status: 503 });
    expect(await loadImageryCoverage()).toBeNull();
    answer = ok;
    expect((await loadImageryCoverage())?.sets).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test('a network error is not kept either', async () => {
    answer = () => {
      throw new TypeError('offline');
    };
    expect(await loadImageryCoverage()).toBeNull();
    answer = ok;
    expect(await loadImageryCoverage()).not.toBeNull();
    expect(calls).toBe(2);
  });

  test('while it cannot be read, the map credits every source', async () => {
    answer = () => new Response('down', { status: 503 });
    expect(await imageryCreditsFor(SANT_GERVASI)).toEqual(ALL_SOURCES);
    answer = ok;
    expect(await imageryCreditsFor(LISBON)).toEqual([]);
  });
});

describe('an engine error over imagery', () => {
  test('an imagery tier’s 404 is a normal answer: no "Map data unavailable"', () => {
    for (const tier of ['base', 'detail', 'fine']) {
      expect(
        mapErrorOutcome({ sourceId: `goway:imagery:${tier}`, error: { status: 404 } }),
      ).toEqual({ kind: 'ignore' });
    }
  });

  test('any other imagery failure is reported, and the map stays up', () => {
    expect(
      mapErrorOutcome({
        sourceId: 'goway:imagery:detail',
        error: { status: 502, message: 'Bad Gateway' },
      }),
    ).toEqual({
      kind: 'report',
      key: 'imagery:tiles',
      message: 'imagery: a tile failed (Bad Gateway).',
    });
  });

  test('a basemap tile or the style is still the map’s error', () => {
    expect(
      mapErrorOutcome({ sourceId: 'openmaptiles', error: { status: 404, message: 'gone' } }),
    ).toEqual({ kind: 'error', reason: 'tiles', message: 'gone' });
    expect(mapErrorOutcome({ error: { message: 'no style' } })).toEqual({
      kind: 'error',
      reason: 'style',
      message: 'no style',
    });
  });

  test('the web canvas decides by this rule', async () => {
    const source = await Bun.file(new URL('../MapCanvas.web.tsx', import.meta.url)).text();
    const handler = source.slice(source.indexOf('const handleError'));
    expect(handler.slice(0, handler.indexOf('\n    };\n'))).toContain('mapErrorOutcome(');
  });
});

describe('the native canvas’s settled view', () => {
  const BARCELONA: NativeViewState = {
    center: [2.13, 41.42],
    zoom: 16,
    bearing: 0,
    pitch: 0,
    bounds: [2.12, 41.415, 2.14, 41.43],
  };
  const MOVED: NativeRegionChange = {
    ...BARCELONA,
    zoom: 15,
    bounds: [2.1, 41.4, 2.16, 41.44],
    userInteraction: true,
  };
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
  };

  function reports(viewportListener = false) {
    const views: NativeViewState[] = [];
    let reads = 0;
    const camera = createNativeCameraReports(
      () => (viewportListener ? () => {} : undefined),
      () => (view) => views.push(view),
    );
    const getViewState = async () => {
      reads += 1;
      return BARCELONA;
    };
    return { camera, views, getViewState, reads: () => reads };
  }

  test('a map opened and never moved has a view once its style loads', async () => {
    // No viewport listener (the embed passes none) and no region event.
    const { camera, views, getViewState } = reports();
    camera.loaded(getViewState);
    await settle();
    expect(views).toEqual([BARCELONA]);
  });

  test('every style load gives the view, not only the engine’s first', async () => {
    const { camera, views, getViewState } = reports(true);
    camera.loaded(getViewState);
    await settle();
    camera.loaded(getViewState); // switched to satellite under the same engine
    await settle();
    expect(views).toHaveLength(2);
  });

  test('one getViewState read serves the camera report and the view', async () => {
    const { camera, getViewState, reads } = reports(true);
    camera.loaded(getViewState);
    await settle();
    expect(reads()).toBe(1);
  });

  test('settled moves give the view; a flyover frame does not', () => {
    const { camera, views } = reports();
    camera.regionDidChange(MOVED);
    camera.commanded(true);
    camera.regionDidChange({ ...MOVED, userInteraction: false });
    expect(views).toEqual([MOVED]);
  });

  test('a load’s read landing after a settled move does not put the old camera back', async () => {
    const { camera, views } = reports();
    let answer: (view: NativeViewState) => void = () => {};
    camera.loaded(
      () =>
        new Promise<NativeViewState>((resolve) => {
          answer = resolve;
        }),
    );
    camera.regionDidChange(MOVED);
    answer(BARCELONA);
    await settle();
    expect(views).toEqual([MOVED]);
  });

  test('the native canvas credits by it, on every engine (a retry makes a new one)', async () => {
    const source = await Bun.file(new URL('../MapCanvas.native.tsx', import.meta.url)).text();
    const wired = source.split('createNativeCameraReports(').slice(1);
    expect(wired).toHaveLength(2);
    for (const call of wired) {
      expect(call.slice(0, call.indexOf(');'))).toContain('() => settledViewListener.current');
    }
    expect(source).toContain('(view) => setImageryView(imageryViewOf(view.zoom, view.bounds))');
  });

  test('an engine that cannot answer leaves the view to the next move', async () => {
    const { camera, views } = reports();
    camera.loaded(() => {
      throw new Error('no engine');
    });
    await settle();
    expect(views).toEqual([]);
  });
});
