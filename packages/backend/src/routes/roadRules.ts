/**
 * Road rules, public and signed out (`docs/ROAD_RULES.md`):
 *
 *  - `GET /roads/rule-sets` — each country's driving side and implicit speeds.
 *  - `GET /roads/rules`     — what applies at a position.
 *  - `GET /roads/zones`     — zones in a box or a country.
 *  - `POST /roads/access`   — may this vehicle enter here, now.
 *
 * Rules change when an authority changes them, a few times a year, so the GETs
 * are cacheable for five minutes. `POST /roads/access` is a read whose argument
 * is a vehicle: it sets `Cache-Control: no-store`, writes nothing and logs
 * nothing of the profile — a car's fuel and label are personal data.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  decideAccess,
  roadAccessInputSchema,
  roadRuleSetListQuerySchema,
  roadRulesQuerySchema,
  roadZoneListQuerySchema,
} from '@goway/contracts';
import { getDb } from '../db/postgres';
import { listRuleSets, listZones, ruleSetFor, zonesAt } from '../db/roadRules/roadRulesRepository';
import type { RoadRuleSet, RoadZone } from '@goway/contracts';
import { countryIndex } from '../roadrules/countryIndex';
import { cursorBinding, decodeCursor, pageOf } from '../http/cursor';
import { parseBody, parseQuery } from '../http/validation';
import { z } from 'zod';

const ROAD_RULES_CACHE_CONTROL = 'public, max-age=300';

/** A list position: the last id (or country) served. */
const afterSchema = z.string().min(1).max(64);

/**
 * What the router reads. The database by default; injected in tests, so the
 * paging, cursors and the access decision are exercised without Postgres.
 */
export interface RoadRulesStore {
  listRuleSets(window: {
    limit: number;
    after?: string | undefined;
  }): Promise<{ countryCode: string; ruleSet: RoadRuleSet }[]>;
  ruleSetFor(countryCode: string): Promise<RoadRuleSet | null>;
  zonesAt(position: { latitude: number; longitude: number }): Promise<RoadZone[]>;
  listZones(
    filter: Parameters<typeof listZones>[1],
    window: { limit: number; after?: string | undefined },
  ): Promise<{ id: string; zone: RoadZone }[]>;
  countryAt(position: { latitude: number; longitude: number }): Promise<string | null>;
}

const databaseStore: RoadRulesStore = {
  listRuleSets: (window) => listRuleSets(getDb(), window),
  ruleSetFor: (countryCode) => ruleSetFor(getDb(), countryCode),
  zonesAt: (position) => zonesAt(getDb(), position),
  listZones: (filter, window) => listZones(getDb(), filter, window),
  countryAt: async (position) => (await countryIndex(getDb())).at(position),
};

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

export function createRoadRulesRouter(store: RoadRulesStore = databaseStore): Router {
  const router: Router = Router();

  router.get(
    '/roads/rule-sets',
    route(async (request, response) => {
      const { limit, cursor } = parseQuery(roadRuleSetListQuerySchema, request.query);
      const binding = cursorBinding('road-rule-sets', {});
      const rows = await store.listRuleSets({
        limit,
        after: decodeCursor(cursor, binding, afterSchema),
      });
      response.setHeader('Cache-Control', ROAD_RULES_CACHE_CONTROL);
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (row) => row.countryCode,
          (row) => row.ruleSet,
        ),
      );
    }),
  );

  router.get(
    '/roads/rules',
    route(async (request, response) => {
      const query = parseQuery(roadRulesQuerySchema, request.query);
      const zones = await store.zonesAt(query);
      // The caller's country wins; otherwise the one GoWay's borders put the
      // position in, and a position in none (open water) has no rule set.
      const countryCode = query.country ?? (await store.countryAt(query));
      const ruleSet = countryCode ? await store.ruleSetFor(countryCode) : null;
      response.setHeader('Cache-Control', ROAD_RULES_CACHE_CONTROL);
      response.json({ countryCode, ruleSet, zones });
    }),
  );

  router.get(
    '/roads/zones',
    route(async (request, response) => {
      const { west, south, east, north, country, kind, limit, cursor } = parseQuery(
        roadZoneListQuerySchema,
        request.query,
      );
      const box =
        west !== undefined && south !== undefined && east !== undefined && north !== undefined
          ? { west, south, east, north }
          : undefined;
      const binding = cursorBinding('road-zones', {
        west,
        south,
        east,
        north,
        country,
        kind,
      });
      const rows = await store.listZones(
        { box, country, kind },
        { limit, after: decodeCursor(cursor, binding, afterSchema) },
      );
      response.setHeader('Cache-Control', ROAD_RULES_CACHE_CONTROL);
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (row) => row.id,
          (row) => row.zone,
        ),
      );
    }),
  );

  router.post(
    '/roads/access',
    route(async (request, response) => {
      const input = parseBody(roadAccessInputSchema, request.body);
      const zones = await store.zonesAt(input);
      const at = input.at ? new Date(input.at) : new Date();
      response.setHeader('Cache-Control', 'no-store');
      response.json(decideAccess(zones, input, input.vehicle, at));
    }),
  );

  return router;
}
