/**
 * Street 3D fixtures: coverage and scene manifests, typed as the published
 * contract (`packages/shared-types/src/street3d.ts`) and served by
 * `mockTransport.ts` when `EXPO_PUBLIC_GOWAY_FIXTURES` is on.
 *
 * ## The splat itself is configuration, not a file in this repository
 *
 * No sample `.spz` is committed or linked by default: GoWay ships only assets
 * whose licence has been verified, and a fixture is no exception. To see real
 * pixels locally, point these at any `.spz` you are entitled to use (and a
 * JPEG poster), served over HTTPS (the SDK rejects any other asset URL, as the
 * contract requires) with `Access-Control-Allow-Origin` for your dev origin:
 *
 *     EXPO_PUBLIC_STREET3D_FIXTURE_SPLAT_URL=
 *     EXPO_PUBLIC_STREET3D_FIXTURE_PREVIEW_URL=   # optional, defaults to the splat
 *     EXPO_PUBLIC_STREET3D_FIXTURE_POSTER_URL=    # optional
 *
 * Unset, the URLs are on the reserved `.invalid` TLD (RFC 2606), which can never
 * resolve — so the viewer's load-failure state is what a fresh checkout shows,
 * and nothing is ever fetched from a host nobody chose.
 *
 * Without `EXPO_PUBLIC_STREET3D_FIXTURE_ANCHOR`, the fixtures are Barcelona
 * examples: a plausible stretch of La Rambla (so the fixture Places at the
 * Boqueria and Liceu fall inside it and get labels), an approximately placed
 * second scene, and one area per state. WITH an anchor there is exactly one
 * scene, `s3d_fixture_anchor`, placed there — never a local scene shown beside
 * fake Barcelona chips that would open the same file.
 *
 * The transform is the IDENTITY, which is what the reconstruction worker
 * publishes today: scene space IS metric ENU around the anchor (x east, y
 * north, z up, ground ≈ 0), so the viewer must take "up" from the transform
 * rather than assume three.js's Y-up. When pointing the fixture at a real
 * local scene, also give its anchor and opening camera:
 *
 *     EXPO_PUBLIC_STREET3D_FIXTURE_ANCHOR=lat,lng,altitude
 *     EXPO_PUBLIC_STREET3D_FIXTURE_VIEW=px,py,pz,tx,ty,tz   # scene coordinates
 *     EXPO_PUBLIC_STREET3D_FIXTURE_ATTRIBUTION=…            # the asset's credit
 *     EXPO_PUBLIC_STREET3D_FIXTURE_NAVIGATION_URL=…         # JSON, `navigation` shape
 *
 * The navigation URL is fetched by the app (so it needs CORS for the dev
 * origin) and attached to the first fixture scene as `navigation`, which turns
 * on the viewer's guided Walk mode. It goes through the SDK's parser like the
 * rest of the manifest, so a malformed file fails the same way a malformed
 * API answer would.
 */
import type {
  StreetCoverage,
  StreetCoverageArea,
  StreetSceneAsset,
  StreetSceneManifest,
  StreetSceneSummary,
} from '@goway/shared-types';

const UNSET_ORIGIN = 'https://street3d-fixture.goway.invalid';

const env = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const SPLAT_URL = env(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_SPLAT_URL);
const PREVIEW_URL = env(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_PREVIEW_URL);
const POSTER_URL = env(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_POSTER_URL);
const ATTRIBUTION = env(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_ATTRIBUTION);

/** `"a,b,c"` → numbers, or `undefined` unless exactly `count` finite values. */
function numbers(value: string | undefined, count: number): number[] | undefined {
  const parts = env(value)?.split(',').map((part) => Number(part.trim()));
  return parts && parts.length === count && parts.every(Number.isFinite) ? parts : undefined;
}

// The SDK refuses a manifest whose asset URLs are not `https:` (the published
// contract), and this transport is answered THROUGH the SDK — so an `http:`
// fixture URL turns into "this 3D view couldn't be loaded". Say why, once.
for (const [name, url] of [['SPLAT', SPLAT_URL], ['PREVIEW', PREVIEW_URL], ['POSTER', POSTER_URL]] as const) {
  if (url && !/^https:\/\//i.test(url)) {
    console.warn(`[goway/street3d] EXPO_PUBLIC_STREET3D_FIXTURE_${name}_URL must be https: — the SDK rejects other asset URLs.`);
  }
}

const NAVIGATION_URL = env(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_NAVIGATION_URL);

const ANCHOR = numbers(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_ANCHOR, 3);
const VIEW = numbers(process.env.EXPO_PUBLIC_STREET3D_FIXTURE_VIEW, 6);

const DAY_MS = 86_400_000;
const NOW = Date.now();
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY_MS).toISOString();

const FAKE_SHA = '0'.repeat(64);

function assets(id: string): StreetSceneAsset[] {
  const splat = SPLAT_URL ?? `${UNSET_ORIGIN}/${id}/scene.spz`;
  const list: StreetSceneAsset[] = [
    { role: 'splat_preview', format: 'spz', url: PREVIEW_URL ?? splat, byteSize: 2_400_000, sha256: FAKE_SHA, gaussians: 150_000 },
    { role: 'splat', format: 'spz', url: splat, byteSize: 18_000_000, sha256: FAKE_SHA, gaussians: 1_200_000 },
  ];
  list.push({
    role: 'poster',
    format: 'jpeg',
    url: POSTER_URL ?? `${UNSET_ORIGIN}/${id}/poster.jpg`,
    byteSize: 180_000,
    sha256: FAKE_SHA,
  });
  return list;
}

function rectangle(west: number, south: number, east: number, north: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/** Scene space is ENU (column-major identity). */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** ~150 m around an anchor, for an env-configured scene's bounds. */
function boundsAround(latitude: number, longitude: number) {
  const dLat = 150 / 111_320;
  const dLon = 150 / (111_320 * Math.cos((latitude * Math.PI) / 180));
  return { west: longitude - dLon, south: latitude - dLat, east: longitude + dLon, north: latitude + dLat };
}

interface SceneSeed {
  id: string;
  anchor: { latitude: number; longitude: number; altitudeMeters: number };
  bounds: { west: number; south: number; east: number; north: number };
  placement: 'precise' | 'approximate';
}

/** The anchor-driven scene: ONE scene, the configured one, and nothing invented beside it. */
export const ANCHORED_FIXTURE_SCENE_ID = 's3d_fixture_anchor';
/** The Barcelona examples, used only when no anchor is configured. */
export const BARCELONA_FIXTURE_SCENE_ID = 's3d_fixture_rambla_liceu';

const SCENES: readonly SceneSeed[] = ANCHOR
  ? [
      {
        id: ANCHORED_FIXTURE_SCENE_ID,
        anchor: { latitude: ANCHOR[0], longitude: ANCHOR[1], altitudeMeters: ANCHOR[2] },
        bounds: boundsAround(ANCHOR[0], ANCHOR[1]),
        placement: 'precise',
      },
    ]
  : [
      {
        id: BARCELONA_FIXTURE_SCENE_ID,
        anchor: { latitude: 41.381, longitude: 2.1725, altitudeMeters: 52 },
        bounds: { west: 2.1705, south: 41.3797, east: 2.1745, north: 41.3825 },
        placement: 'precise',
      },
      {
        id: 's3d_fixture_santa_caterina',
        anchor: { latitude: 41.3868, longitude: 2.1782, altitudeMeters: 50 },
        bounds: { west: 2.1770, south: 41.3860, east: 2.1795, north: 41.3877 },
        placement: 'approximate',
      },
    ];

function manifestOf(seed: SceneSeed): StreetSceneManifest {
  const { west, south, east, north } = seed.bounds;
  return {
    id: seed.id,
    version: 3,
    bounds: seed.bounds,
    footprint: rectangle(west, south, east, north),
    worldTransform: { anchor: seed.anchor, frame: 'enu', enuFromScene: [...IDENTITY] },
    // Eye height above ground (z ≈ 0), 30 m south of the anchor, looking north.
    initialView: VIEW
      ? { position: [VIEW[0], VIEW[1], VIEW[2]], target: [VIEW[3], VIEW[4], VIEW[5]] }
      : { position: [0, -30, 1.7], target: [0, 0, 1.5] },
    assets: assets(seed.id),
    quality: {
      profile: 'standard',
      registrationRatio: 0.93,
      alignmentResidualMeters: seed.placement === 'precise' ? 0.4 : 3.8,
      heldOutPsnr: 24.1,
      placement: seed.placement,
    },
    observedFrom: iso(-120),
    observedTo: iso(-95),
    publishedAt: iso(-60),
    attributions: [ATTRIBUTION ?? 'Fixture scene — local development data, not a published GoWay view'],
    privacyPipelineVersions: ['privacy-2026.09'],
  };
}

export const FIXTURE_SCENES: ReadonlyMap<string, StreetSceneManifest> = new Map(
  SCENES.map((seed) => [seed.id, manifestOf(seed)]),
);

function summaryOf(manifest: StreetSceneManifest): StreetSceneSummary {
  const { west, south, east, north } = manifest.bounds;
  const poster = manifest.assets.find((asset) => asset.role === 'poster');
  return {
    id: manifest.id,
    version: manifest.version,
    center: { latitude: (south + north) / 2, longitude: (west + east) / 2 },
    bounds: manifest.bounds,
    footprint: manifest.footprint,
    placement: manifest.quality.placement,
    ...(poster ? { posterUrl: poster.url } : {}),
    publishedAt: manifest.publishedAt,
  };
}

/**
 * Without an anchor: one area per state, so every style is visible in one
 * Barcelona viewport. With one: a single at-risk and a single partial cell
 * beside the configured scene, so the hint and the dots still have something
 * to show without inventing a second city around a real local scene.
 */
const CELL = 0.0012;
function area(id: string, state: StreetCoverageArea['state'], latitude: number, longitude: number,
  extra: Partial<StreetCoverageArea> = {}): StreetCoverageArea {
  return {
    id,
    state,
    center: { latitude, longitude },
    bounds: { west: longitude - CELL / 2, south: latitude - CELL / 2, east: longitude + CELL / 2, north: latitude + CELL / 2 },
    contributionBand: '5-19',
    ...extra,
  };
}

function offset(latitude: number, longitude: number, eastMeters: number, northMeters: number) {
  return {
    latitude: latitude + northMeters / 111_320,
    longitude: longitude + eastMeters / (111_320 * Math.cos((latitude * Math.PI) / 180)),
  };
}

function anchoredAreas(latitude: number, longitude: number): StreetCoverageArea[] {
  const east = offset(latitude, longitude, 260, 0);
  const west = offset(latitude, longitude, -260, 0);
  return [
    area('a_fixture_anchor_at_risk', 'at_risk', east.latitude, east.longitude, { atRiskUntil: iso(9) }),
    area('a_fixture_anchor_partial', 'partial', west.latitude, west.longitude),
  ];
}

export const FIXTURE_AREAS: readonly StreetCoverageArea[] = ANCHOR
  ? anchoredAreas(ANCHOR[0], ANCHOR[1])
  : [
      area('a_fixture_born', 'at_risk', 41.3846, 2.1820, { atRiskUntil: iso(9) }),
      area('a_fixture_raval', 'partial', 41.3800, 2.1680),
      area('a_fixture_gotic', 'seeded', 41.3830, 2.1770, { contributionBand: '1-4' }),
      area('a_fixture_barceloneta', 'reconstructable', 41.3800, 2.1890, { contributionBand: '20+' }),
      area('a_fixture_sant_pere', 'reconstructing', 41.3885, 2.1765, { contributionBand: '20+' }),
      area('a_fixture_poble_sec', 'needs_more_capture', 41.3745, 2.1640),
      area('a_fixture_liceu', 'partial', 41.3806, 2.1732, { sceneId: BARCELONA_FIXTURE_SCENE_ID }),
    ];

const intersects = (
  a: { west: number; south: number; east: number; north: number },
  b: { west: number; south: number; east: number; north: number },
) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

export function fixtureCoverage(box: { west: number; south: number; east: number; north: number }): StreetCoverage {
  return {
    scenes: [...FIXTURE_SCENES.values()].filter((scene) => intersects(scene.bounds, box)).map(summaryOf),
    areas: FIXTURE_AREAS.filter((entry) => intersects(entry.bounds, box)),
  };
}

let navigation: Promise<unknown> | null = null;

/**
 * The fixture manifest for `id` as the API would answer it: with the
 * configured `navigation` attached to the first fixture scene. `undefined`
 * for an unknown id.
 */
export async function fixtureSceneResponse(id: string): Promise<StreetSceneManifest | undefined> {
  const manifest = FIXTURE_SCENES.get(id);
  if (!manifest) return undefined;
  const first = FIXTURE_SCENES.keys().next().value;
  if (!NAVIGATION_URL || id !== first) return manifest;
  navigation ??= fetch(NAVIGATION_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    })
    .catch((error: unknown) => {
      console.warn(`[goway/street3d] EXPO_PUBLIC_STREET3D_FIXTURE_NAVIGATION_URL could not be loaded: ${String(error)}`);
      navigation = null;
      return undefined;
    });
  const loaded = await navigation;
  return loaded === undefined ? manifest : ({ ...manifest, navigation: loaded } as StreetSceneManifest);
}
