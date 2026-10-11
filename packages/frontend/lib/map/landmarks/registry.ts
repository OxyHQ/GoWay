/**
 * The landmark registry's schema: what `public/landmarks/registry.json` must
 * say about every hand-crafted landmark model before the map may draw it.
 * Design note: `docs/MAP_LANDMARKS.md`.
 *
 * ## Why a reviewed data file, and why here
 *
 * A landmark is a MODEL — an asset GoWay authored (or licensed), built by a
 * committed generator, reviewed in a pull request with its licence and its
 * provenance — plus the few facts that put it on the map. Nothing about it is
 * written by users or moderators, it changes exactly when an asset changes,
 * and the asset ships with the app as a static file. So the registry ships
 * beside the assets as data (`public/landmarks/registry.json`), validated by
 * this schema at build time (`scripts/build-landmarks.ts`), in the tests, and
 * again when the app reads it. A Drizzle table would add a route, a
 * moderation surface and a migration for data no API caller writes; it is the
 * right home only once landmarks become PLACE-attached models uploaded by
 * people (`docs/SDK_MAP_MODELS.md` phase 4), which is a different feature.
 *
 * It is not a public contract: the SDK draws no map, and no third party reads
 * this file. The one wire type it reuses is the model PLACEMENT, parsed by the
 * contract's own `parseModelPlacement`, so a landmark stands on the map by
 * exactly the rules any SDK model does.
 *
 * ## The licence rule, as code
 *
 * Every entry names its licence (an allow-listed SPDX id), its method, its
 * author, its source and when that was verified. CC BY requires the credit
 * text the map shows while the model is drawn; NC, ND, "unknown" and anything
 * not on the list fail to parse, so they cannot ship.
 */
import { parseModelPlacement } from '@goway.to/sdk';
import { z } from 'zod';

/** An OpenStreetMap element as GoWay's place sources spell it (`way/34633854`). */
export const osmElementSchema = z.string().regex(/^(node|way|relation)\/[1-9]\d{0,14}$/);
export type OsmElement = z.infer<typeof osmElementSchema>;

/**
 * Licences a landmark asset may carry. Public redistribution with the app,
 * modification allowed, commercial use allowed — so no NC, no ND.
 */
export const LANDMARK_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0'] as const;
export type LandmarkLicence = (typeof LANDMARK_LICENCES)[number];

/** Licences whose terms oblige a visible credit. */
const CREDIT_REQUIRED: ReadonlySet<LandmarkLicence> = new Set(['CC-BY-4.0', 'CC-BY-3.0']);

/**
 * How the asset was made (`docs/MAP_LANDMARKS.md` → Sourcing):
 * `procedural` is GoWay's own geometry code; `osm-enriched` is GoWay's code
 * over OpenStreetMap's own recorded geometry (an ODbL Produced Work — the
 * map's "© OpenStreetMap" credit covers it); `third-party` is a licensed
 * asset from an outside author.
 */
export const LANDMARK_METHODS = ['procedural', 'osm-enriched', 'third-party'] as const;

const hexColour = z.string().regex(/^#[0-9a-f]{6}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const landmarkSchema = z
  .object({
    /** Stable slug; also the asset's file name. */
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** The default (local-language) proper name, as `places.name` holds it. */
    name: z.string().min(1).max(120),
    /** A key of GoWay's category taxonomy; its label comes from `GET /categories`. */
    category: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
    /** Where it is, for the caption (`Statue · New York`): a proper name, not a label. */
    locality: z.string().min(1).max(80),
    osm: z.object({
      /** The landmark's own element — what a GoWay Place's `openstreetmap` source names. */
      element: osmElementSchema,
      /**
       * The city-tile buildings and `building:part`s the model REPLACES: hidden
       * from the city mesh wherever the model is drawn, never deleted.
       */
      replaces: z.array(osmElementSchema).min(1).max(512),
    }),
    /** The GoWay Place ID, once one is known to hold this landmark; else `null`. */
    placeId: z.string().min(1).nullable(),
    /** Where and how the asset stands: the contract's `ModelPlacement` (input form). */
    placement: z.unknown(),
    model: z.object({
      /** Same-origin path of the GLB. */
      path: z.string().regex(/^\/landmarks\/[a-z0-9-]+\.glb$/),
      /** Repository path of the generator that builds it (procedural/osm-enriched). */
      generator: z.string().min(1).nullable(),
      bytes: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      triangles: z.number().int().positive(),
      boundsMeters: z.object({ min: vec3, max: vec3 }),
    }),
    night: z.object({
      /** The warm wash on the facade's stone at night. */
      uplight: z
        .object({
          color: hexColour,
          reach: z.number().positive().max(500),
          strength: z.number().min(0).max(4),
        })
        .nullable(),
    }),
    licence: z.object({
      spdx: z.enum(LANDMARK_LICENCES),
      method: z.enum(LANDMARK_METHODS),
      author: z.string().min(1),
      /** Where the asset (or its generator) comes from: a URL or a repository path. */
      source: z.string().min(1),
      /** The credit the map shows while this model is drawn, or `null` when none is owed. */
      credit: z.string().min(1).nullable(),
      /** Data that informed the geometry (each already credited on every map). */
      derivedFrom: z.array(z.enum(['openstreetmap'])),
      /** When a person checked the licence at its source. */
      verifiedAt: isoDate,
      notes: z.string().min(1),
    }),
    /** The orbit camera of the tour. */
    tour: z.object({
      // From where the city is fully drawn (`BUILDINGS_3D_FADE` ends at 16.5).
      zoom: z.number().min(16.5).max(20),
      pitch: z.number().min(0).max(60),
      /** Seconds per full orbit while playing. */
      orbitSeconds: z.number().min(10).max(240),
      /** Metres above the base the camera looks at (the landmark's visual middle). */
      lookAtMeters: z.number().min(0).max(600),
      /**
       * Where round the orbit the tour opens, degrees from facing the main
       * facade: a facade a taller neighbour hides (Chrysler behind One
       * Vanderbilt) is better met from another side. Absent: 0.
       */
      startAngle: z.number().min(-180).max(180).optional(),
    }),
  })
  .superRefine((landmark, ctx) => {
    if (!parseModelPlacement(landmark.placement)) {
      ctx.addIssue({ code: 'custom', path: ['placement'], message: 'not a drawable placement' });
    }
    if (CREDIT_REQUIRED.has(landmark.licence.spdx) && !landmark.licence.credit) {
      ctx.addIssue({
        code: 'custom',
        path: ['licence', 'credit'],
        message: `${landmark.licence.spdx} requires a credit`,
      });
    }
    if (landmark.licence.method === 'third-party' && !/^https:\/\//.test(landmark.licence.source)) {
      ctx.addIssue({
        code: 'custom',
        path: ['licence', 'source'],
        message: 'a third-party asset names the https URL its licence was verified at',
      });
    }
    if (landmark.licence.method !== 'third-party' && !landmark.model.generator) {
      ctx.addIssue({
        code: 'custom',
        path: ['model', 'generator'],
        message: 'a GoWay-authored asset names its generator',
      });
    }
    if (landmark.model.path !== `/landmarks/${landmark.id}.glb`) {
      ctx.addIssue({ code: 'custom', path: ['model', 'path'], message: 'path must be the id' });
    }
    if (new Set(landmark.osm.replaces).size !== landmark.osm.replaces.length) {
      ctx.addIssue({ code: 'custom', path: ['osm', 'replaces'], message: 'duplicate element' });
    }
  });

export type LandmarkEntry = z.infer<typeof landmarkSchema>;

export const landmarkRegistrySchema = z
  .object({
    version: z.literal(1),
    landmarks: z.array(landmarkSchema),
  })
  .superRefine((registry, ctx) => {
    const ids = new Set<string>();
    const replaced = new Map<string, string>();
    registry.landmarks.forEach((landmark, i) => {
      if (ids.has(landmark.id)) {
        ctx.addIssue({ code: 'custom', path: ['landmarks', i, 'id'], message: 'duplicate id' });
      }
      ids.add(landmark.id);
      for (const element of landmark.osm.replaces) {
        const owner = replaced.get(element);
        if (owner) {
          ctx.addIssue({
            code: 'custom',
            path: ['landmarks', i, 'osm', 'replaces'],
            message: `${element} is already replaced by ${owner}`,
          });
        }
        replaced.set(element, landmark.id);
      }
    });
  });

export type LandmarkRegistry = z.infer<typeof landmarkRegistrySchema>;

/**
 * The city tiles' feature id of an element: Planetiler's `osmId × 10 + 2|3`
 * (`scripts/citygen/compile.ts`). Nodes are never buildings in the tiles.
 */
export function cityFeatureId(element: OsmElement): number | null {
  const [type, raw] = element.split('/');
  const id = Number(raw);
  if (!Number.isSafeInteger(id * 10 + 3)) return null;
  if (type === 'way') return id * 10 + 2;
  if (type === 'relation') return id * 10 + 3;
  return null;
}

/** Parse a registry document; throws with every problem listed. */
export function parseLandmarkRegistry(input: unknown): LandmarkRegistry {
  return landmarkRegistrySchema.parse(input);
}
