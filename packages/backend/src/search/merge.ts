/**
 * Enrichment and duplicate grouping: where external candidates and GoWay-owned
 * places become one list.
 *
 * ## Grouping is DETERMINISTIC, and name similarity is not part of it
 *
 * Two candidates are the same thing only when they carry the same OpenStreetMap
 * element reference, or when both reconcile to the same GoWay place — and a
 * candidate reconciles to a place only through `places_sources`, the
 * `(source, sourceId)` binding that issue #4 made unique. That is the same rule
 * the Places importer follows, and for the same reason: a merge is not
 * reversible from the outside, and a false positive collapses two real
 * businesses into one record that a deep link, a claim and a capability now all
 * point at wrongly. "Farmacia" names several thousand distinct real places in
 * Spain alone.
 *
 * So GoWay will happily show two cafés with the same name fifty metres apart —
 * because they usually are two cafés — while never showing the SAME café twice
 * because Photon and GoWay Places both know about it.
 *
 * ## Provenance survives the merge
 *
 * When a group reconciles to a GoWay place, that place represents the group:
 * GoWay owns stable identity, and one identity is the whole point of grouping.
 * Nothing is lost by it, because the only way into that group was a
 * `places_sources` binding, and `place.sources` publishes every one of those
 * bindings — the OSM element the external candidate came from is right there in
 * the result, alongside the capabilities and verification that made the
 * enrichment worth doing. The embedded place is always attached for the same
 * reason: a `placeId` with nothing behind it would move the provenance a second
 * round trip away.
 */

import type {
  CapabilityKey,
  Place,
  SearchResult,
  SearchResultKind,
  SearchSource,
} from '@goway/shared-types';
import { placeDisplayName } from '@goway/shared-types';
import type { SourceRefInput } from '../db/places/placesRepository';
import { composeDisplayName, contextFrom, put, resultId } from './normalize';
import type { PlacesGateway } from './placesGateway';
import { sourceRefKey } from './placesGateway';
import type { ProviderCandidate } from './provider';
import { fusedScore, type SpatialBias } from './ranking';

/** One provider's answer, in the order the provider returned it. */
export interface CandidateList {
  source: SearchSource;
  candidates: readonly ProviderCandidate[];
}

interface Member {
  source: SearchSource;
  rank: number;
  candidate: ProviderCandidate;
}

interface Group {
  key: string;
  members: Member[];
  placeId?: string;
  place?: Place;
}

/**
 * A GoWay place as a search result.
 *
 * `kind` is `poi` for a categorised place and `place` otherwise. GoWay Places
 * holds businesses and venues, not the gazetteer — there is no GoWay-owned
 * `country` row for the same reason there is no GoWay-owned copy of the planet.
 */
export function searchResultFromPlace(place: Place): SearchResult {
  const kind: SearchResultKind = place.categories.length > 0 ? 'poi' : 'place';
  const result: SearchResult = {
    id: resultId('goway', place.id),
    displayName: composeDisplayName([
      // The resolved name when the request asked for a locale and GoWay holds
      // one, and the default otherwise — `placeDisplayName` is the contract's
      // own one-liner, so this label and the one the client renders beside it
      // cannot disagree.
      placeDisplayName(place),
      place.address?.city,
      place.address?.region,
      place.address?.country,
    ]),
    kind,
    coordinate: place.location,
    source: 'goway',
    sourceId: place.id,
    placeId: place.id,
    place,
  };
  put(result, 'address', place.address);
  put(result, 'context', contextFrom(place.address));
  return result;
}

/** Whether a place asserts every requested capability. A conjunction, as in Places. */
function assertsAll(place: Place | undefined, capabilities: readonly CapabilityKey[]): boolean {
  if (capabilities.length === 0) return true;
  if (!place) return false;
  const held = new Set(place.capabilities.map((capability) => capability.key));
  return capabilities.every((capability) => held.has(capability));
}

/**
 * The representative of a group.
 *
 * A reconciled place wins: it carries the stable identity, the capabilities and
 * the verification, and its coordinate is the one a GoWay deep link resolves
 * to. What the external candidate still contributes is what the place record
 * does not have — an extent to frame the camera with, and a structured address
 * where GoWay holds none. Neither is invented: both come from a source that the
 * place's own `sources` list names.
 */
function representative(group: Group): SearchResult | undefined {
  if (group.place) {
    const result = searchResultFromPlace(group.place);
    // The best EXTERNAL member, not simply the first: GoWay's own row is added
    // to the group before any provider's, and layering it onto itself would
    // quietly drop the extent and address the geocoder did supply.
    const external = group.members.find((member) => member.source !== 'goway')?.candidate.result;
    if (external) {
      if (result.boundingBox === undefined) put(result, 'boundingBox', external.boundingBox);
      if (result.address === undefined) {
        put(result, 'address', external.address);
        put(result, 'context', external.context);
      }
    }
    return result;
  }

  const [best] = group.members;
  if (!best) return undefined;
  // No GoWay place: the candidate keeps its own provenance verbatim. `source`
  // and `sourceId` are never rewritten to look like something they are not.
  return best.candidate.result;
}

export interface MergeRequest {
  /** Provider answers, in provider priority order. */
  lists: readonly CandidateList[];
  /** GoWay-owned places already fetched for this query, in their own order. */
  places?: readonly Place[];
  gateway: PlacesGateway;
  limit: number;
  /** A conjunction. A candidate with no reconciled place cannot satisfy one. */
  capabilities?: readonly CapabilityKey[];
  bias?: SpatialBias | undefined;
  /** BCP 47 tag the reconciled places' names are resolved against. */
  locale?: string | undefined;
}

/**
 * Reconcile, group, rank and truncate.
 *
 * Reconciliation is two bounded round trips regardless of how many providers
 * answered: one to resolve every distinct source reference to a place id, one
 * to load the distinct places. Doing it per candidate would be the same
 * information at N times the cost, and the cost lands inside a keystroke.
 */
export async function mergeCandidates(request: MergeRequest): Promise<SearchResult[]> {
  const { lists, gateway, limit } = request;
  const ownPlaces = request.places ?? [];
  const capabilities = request.capabilities ?? [];

  const refs: SourceRefInput[] = [];
  for (const list of lists) {
    for (const candidate of list.candidates) {
      if (candidate.osmRef) refs.push(candidate.osmRef);
    }
  }
  const placeIdByRef = refs.length === 0 ? new Map<string, string>() : await gateway.findPlaceIdsBySourceRefs(refs);

  const placeById = new Map<string, Place>(ownPlaces.map((place) => [place.id, place]));
  const missing = [...new Set(placeIdByRef.values())].filter((id) => !placeById.has(id));
  if (missing.length > 0) {
    for (const [id, place] of await gateway.findPlacesByIds(missing, request.locale)) placeById.set(id, place);
  }

  const groups = new Map<string, Group>();
  const addMember = (key: string, placeId: string | undefined, member: Member | undefined): Group => {
    let group = groups.get(key);
    if (!group) {
      group = { key, members: [] };
      groups.set(key, group);
    }
    if (placeId !== undefined && group.placeId === undefined) {
      group.placeId = placeId;
      const place = placeById.get(placeId);
      if (place) group.place = place;
    }
    if (member) group.members.push(member);
    return group;
  };

  // GoWay's own places go in FIRST, so a group keyed on a place id already
  // exists when an external candidate reconciles into it.
  ownPlaces.forEach((place, rank) => {
    addMember(`place:${place.id}`, place.id, {
      source: 'goway',
      rank,
      candidate: { result: searchResultFromPlace(place) },
    });
  });

  for (const list of lists) {
    list.candidates.forEach((candidate, rank) => {
      const placeId = candidate.osmRef ? placeIdByRef.get(sourceRefKey(candidate.osmRef)) : undefined;
      const key =
        placeId !== undefined
          ? `place:${placeId}`
          : candidate.osmRef
            ? // Two geocoders that both relay the same OSM element are relaying
              // ONE real-world record, whether or not GoWay has a place for it.
              `osm:${candidate.osmRef.sourceId}`
            : `${String(list.source)}:${candidate.result.sourceId ?? candidate.result.id}`;
      addMember(key, placeId, { source: list.source, rank, candidate });
    });
  }

  const scored: { result: SearchResult; score: number; key: string }[] = [];
  for (const group of groups.values()) {
    if (!assertsAll(group.place, capabilities)) continue;
    const result = representative(group);
    if (!result) continue;
    scored.push({
      result,
      key: group.key,
      score: fusedScore(
        {
          ranks: group.members.map((member) => member.rank),
          coordinate: result.coordinate,
          enriched: group.place !== undefined,
        },
        request.bias,
      ),
    });
  }

  // Ties break on the group key rather than on insertion order, so two requests
  // a keystroke apart cannot reshuffle equally-scored rows under the user.
  scored.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return scored.slice(0, limit).map((entry) => entry.result);
}
