/**
 * URL parameters that aim GoWay's map — shared by the app route and by `/frame`.
 *
 * ## Why this is one module and not two parsers
 *
 * `app/index.tsx` honours `?lat&lng&zoom` so a link can open the app looking at
 * somewhere specific, and `app/frame.tsx` honours the same thing so an
 * `<iframe>` can. Those are the same question asked by two callers, and two
 * implementations of it would be two sets of range checks, two answers to
 * "what does `zoom=abc` do", and one of them eventually wrong. Everything
 * about reading a camera out of a query string lives here; both routes call
 * {@link parseEmbedParams} and neither parses anything itself.
 *
 * ## The contract: a malformed parameter is IGNORED, never fatal
 *
 * This is the rule the whole file is built around, and it is not a style
 * preference. A `NaN` coordinate reaching MapLibre took the entire app down
 * once already (`fix(map): stop a NaN coordinate from taking the whole app
 * down`), and an embed multiplies the exposure: the parameters arrive from a
 * third-party page, in a frame the user cannot reload, built by someone who
 * has never read our documentation and is quite likely concatenating strings.
 * `?center=undefined,undefined` is not a hypothetical — it is what a
 * templating bug produces, and it must render the default view, not a blank
 * frame and a stack trace in somebody else's console.
 *
 * So every reader here returns `undefined` rather than throwing, every number
 * is checked with `Number.isFinite` before it is compared, and every accepted
 * value is clamped into a range the engines accept. `parseEmbedParams` cannot
 * throw for any input. There is a test for exactly that.
 *
 * ## What an embedder may pass, and why that set and no more
 *
 * The shape the product was asked for is Apple's:
 * `https://maps.apple.com/frame?center=LAT%2CLON&span=A%2CB`. GoWay accepts
 * that spelling AND its own, because the two callers have different histories
 * and neither should have to translate:
 *
 *  - `center=LAT,LON` — Apple's spelling of the camera centre.
 *  - `lat=`, `lng=` (or `lon=`) — GoWay's spelling of the same thing.
 *  - `span=LATDELTA,LONDELTA` — Apple's spelling of "how much world to show",
 *    in DEGREES, centred on `center`. Converted to bounds; the renderer fits
 *    them. A span and a zoom together is not a conflict to reject — `zoom`
 *    wins, because it is the more precise instruction and an embedder who sent
 *    both meant the specific one.
 *  - `zoom=` (or `z=`) — GoWay's spelling.
 *  - `bearing=`, `pitch=` — accepted because a map that cannot be shown at an
 *    angle is not the same product as the one in the app.
 *  - `marker=LAT,LON` — repeatable, up to {@link MAX_MARKERS}. An embed whose
 *    only job is "show where we are" needs exactly this and nothing else, and
 *    without it every embedder builds their own overlay on top of our iframe,
 *    which they cannot, because it is an iframe.
 *  - `place=<GoWay place id>` — the same deep link `/place/<id>` uses, so an
 *    embed can show a REAL place with its real name and category rather than a
 *    pin at a coordinate somebody copied.
 *  - `interactive=0` — a still map. See {@link EmbedParams.interactive}.
 *  - `theme=light|dark` — because an embedder's page has a theme and ours
 *    should not fight it.
 *
 * Deliberately NOT accepted, and each for a reason:
 *
 *  - No arbitrary GeoJSON. An embed parameter that can carry a geometry is an
 *    embed parameter that can carry a megabyte, and the URL length limit
 *    becomes the only thing standing between us and a denial of service.
 *    Overlays belong to `@goway.to/sdk`, where the caller owns the page.
 *  - No style or colour overrides. The cartography is the product. An embedder
 *    who needs different colours needs the SDK, not a query string.
 *  - No API key, and nothing that identifies the embedder. There is nothing to
 *    meter: the read surface is public. Adding a key would be adding a way for
 *    the embed to stop working.
 */
import type { GeoBounds, GeoCoordinate, MapViewport } from '@/components/map/types';
import { DEFAULT_VIEWPORT } from '@/components/map/types';

/**
 * How many `marker=` parameters are honoured.
 *
 * A cap rather than no cap because the parameter is repeatable and arrives
 * from a stranger: without one, a URL a few kilobytes long mounts a few
 * thousand React components inside an iframe on somebody's page. Twenty is
 * comfortably more than the "our three offices" case the parameter exists for,
 * and far below the count at which an embed stops being an embed and starts
 * being an application that should call the SDK.
 */
export const MAX_MARKERS = 20;

/** Web Mercator's conventional truncation. Beyond it the projection diverges. */
const MAX_LATITUDE = 85.051129;

/** What MapLibre accepts. Past 85° the horizon is behind the camera. */
const MAX_PITCH = 85;

/** Above this both engines have no more tiles and start to overzoom badly. */
const MAX_ZOOM = 22;

/**
 * The URL parameters, resolved.
 *
 * Every field is optional because every field may be absent OR malformed, and
 * the two are deliberately indistinguishable to the caller: there is nothing
 * useful a map route can do differently about `zoom=abc` than about no `zoom`
 * at all, and pretending otherwise would put error handling into two screens
 * to no end.
 */
export interface EmbedParams {
  /** Camera centre, when `center=` or `lat`/`lng` gave a usable one. */
  center?: GeoCoordinate;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  /**
   * The box implied by `span=`, centred on {@link EmbedParams.center}.
   *
   * Present only when `span` parsed AND a centre was given — a span with no
   * centre describes a size and no location, which is not a view.
   */
  bounds?: GeoBounds;
  /** `marker=LAT,LON`, in the order given, capped at {@link MAX_MARKERS}. */
  markers: readonly GeoCoordinate[];
  /** `place=` — a GoWay place id to select, trimmed and length-checked. */
  placeId?: string;
  /**
   * Whether the map responds to gestures. Defaults to `true`.
   *
   * `interactive=0` exists because an embed is often decoration: a map in the
   * footer of a contact page should not swallow the scroll of someone trying
   * to reach the page below it. That is the single most complained-about
   * behaviour of every embedded map on the web, and the fix has to be
   * available to the embedder, who is the only one who knows which kind of
   * map theirs is.
   */
  interactive: boolean;
  /** `theme=light|dark`. Absent means "follow the Bloom theme", as the app does. */
  appearance?: 'light' | 'dark';
}

/**
 * The query string as either router or browser hands it over.
 *
 * `expo-router`'s `useLocalSearchParams()` gives `string | string[]` per key
 * (repeated keys arrive as an array), and `URLSearchParams` gives strings.
 * Accepting both is what lets the same function be called from a route and
 * from a test with a plain object.
 */
export type RawParams = Record<string, string | string[] | undefined>;

/** The first value for a key, whichever shape it arrived in. */
function first(params: RawParams, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single.trim() !== '') return single.trim();
  }
  return undefined;
}

/** Every value for a key, whichever shape it arrived in. */
function all(params: RawParams, key: string): string[] {
  const value = params[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * A finite number within a range, or `undefined`.
 *
 * `Number('')` is `0` and `Number(' ')` is `0`, which is why the emptiness
 * check happens in {@link first} rather than here — a bare `?zoom=` must not
 * mean "zoom 0", which is the whole planet in a 200-pixel box and looks
 * exactly like a broken embed.
 */
function finiteInRange(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

/** Same, but out-of-range is clamped instead of rejected. */
function clamped(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/**
 * `LAT,LON`, Apple's spelling.
 *
 * Out of range is REJECTED rather than clamped, unlike zoom or pitch. A zoom
 * of 99 is an embedder overshooting a scale and clamping gives them what they
 * plainly wanted; a latitude of 999 is a bug in their code, and clamping it to
 * 85 would put the map at the north pole and let them believe the parameter
 * worked. The default view is the more honest answer.
 *
 * Longitude is the exception to the exception: it WRAPS, because ±180 is a
 * seam rather than an edge and `lon=185` is a real place. Latitude has no
 * equivalent — there is nothing past the pole.
 */
function parseLatLon(raw: string | undefined): GeoCoordinate | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',');
  if (parts.length !== 2) return undefined;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < -90 || latitude > 90) return undefined;
  if (longitude < -360 || longitude > 360) return undefined;
  return { latitude, longitude: wrapLongitude(longitude) };
}

/**
 * Fold a longitude into [-180, 180].
 *
 * The early return is not an optimisation, it is the correctness of the common
 * case. The modular form below does not round-trip a value that was already in
 * range: `((-0.12 + 180) % 360 + 360) % 360 - 180` is `-0.12000000000000455`,
 * because the intermediate `179.88` cannot be represented exactly and the
 * subtraction cannot undo what the addition lost. That is nine metres of
 * longitude added to every ordinary coordinate somebody passes us, for no
 * reason at all — and it would have shipped, because nine metres is invisible
 * on a map and visible only in a test that compares the number.
 */
function wrapLongitude(longitude: number): number {
  if (longitude >= -180 && longitude <= 180) return longitude;
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  // `-180` and `180` are the same meridian; normalising to `180` keeps a
  // round-trip through this function stable rather than flipping sign.
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * `span=LATDELTA,LONDELTA` around a centre, as a box.
 *
 * Apple's `span` is the FULL width and height in degrees, not a radius, so
 * each delta is halved. A non-positive or absent delta yields no bounds: a
 * zero-height box is degenerate, and both engines answer a degenerate
 * `fitBounds` with their maximum zoom — which is a street-level view of
 * somewhere the embedder asked to see a region of.
 */
function parseSpan(raw: string | undefined, center: GeoCoordinate | undefined): GeoBounds | undefined {
  if (raw === undefined || center === undefined) return undefined;
  const parts = raw.split(',');
  if (parts.length !== 2) return undefined;
  const latSpan = Number(parts[0]);
  const lonSpan = Number(parts[1]);
  if (!Number.isFinite(latSpan) || !Number.isFinite(lonSpan)) return undefined;
  if (latSpan <= 0 || lonSpan <= 0) return undefined;

  const halfLat = Math.min(latSpan, 180) / 2;
  const halfLon = Math.min(lonSpan, 360) / 2;
  return {
    south: Math.max(-MAX_LATITUDE, center.latitude - halfLat),
    north: Math.min(MAX_LATITUDE, center.latitude + halfLat),
    west: center.longitude - halfLon,
    east: center.longitude + halfLon,
  };
}

/**
 * Longest GoWay place id this will carry into a route.
 *
 * Place ids are short and opaque; anything long is either a mistake or an
 * attempt to make the app render an attacker-chosen string somewhere. It is
 * checked here, at the boundary, because that is the only place where "this
 * came from a URL" is still known.
 */
const MAX_PLACE_ID_LENGTH = 128;

/** Read everything the map routes understand out of a query string. Never throws. */
export function parseEmbedParams(params: RawParams): EmbedParams {
  const center = parseLatLon(first(params, 'center')) ?? latLngPair(params);

  const markers: GeoCoordinate[] = [];
  for (const raw of all(params, 'marker')) {
    if (markers.length >= MAX_MARKERS) break;
    const coordinate = parseLatLon(raw);
    if (coordinate) markers.push(coordinate);
  }

  const placeIdRaw = first(params, 'place', 'placeId');
  const placeId =
    placeIdRaw !== undefined && placeIdRaw.length <= MAX_PLACE_ID_LENGTH ? placeIdRaw : undefined;

  const themeRaw = first(params, 'theme');
  const appearance = themeRaw === 'light' || themeRaw === 'dark' ? themeRaw : undefined;

  const interactiveRaw = first(params, 'interactive');
  // Anything other than an explicit opt-out is interactive. An embedder who
  // typed `interactive=yes` meant yes, and so did one who typed nothing.
  const interactive = !(interactiveRaw === '0' || interactiveRaw === 'false' || interactiveRaw === 'no');

  const zoom = finiteInRange(first(params, 'zoom', 'z'), 0, MAX_ZOOM);
  const bearing = clamped(first(params, 'bearing'), -360, 360);
  const pitch = clamped(first(params, 'pitch'), 0, MAX_PITCH);
  const bounds = parseSpan(first(params, 'span'), center);

  return {
    ...(center ? { center } : {}),
    ...(zoom !== undefined ? { zoom } : {}),
    ...(bearing !== undefined ? { bearing } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(bounds ? { bounds } : {}),
    markers,
    ...(placeId ? { placeId } : {}),
    interactive,
    ...(appearance ? { appearance } : {}),
  };
}

/** GoWay's own `lat`/`lng` spelling of a centre. */
function latLngPair(params: RawParams): GeoCoordinate | undefined {
  const lat = first(params, 'lat', 'latitude');
  const lng = first(params, 'lng', 'lon', 'longitude');
  if (lat === undefined || lng === undefined) return undefined;
  return parseLatLon(`${lat},${lng}`);
}

/**
 * The camera to mount with.
 *
 * Falls back field by field rather than all-or-nothing, so `?zoom=15` alone
 * means "the default place, closer" instead of being silently dropped for want
 * of a centre. That asymmetry is deliberate: a partial instruction is still an
 * instruction, and the alternative is an embedder who cannot tell whether
 * their parameter was wrong or their whole URL was.
 */
export function initialViewportFrom(parsed: EmbedParams): MapViewport {
  return {
    latitude: parsed.center?.latitude ?? DEFAULT_VIEWPORT.latitude,
    longitude: parsed.center?.longitude ?? DEFAULT_VIEWPORT.longitude,
    zoom: parsed.zoom ?? DEFAULT_VIEWPORT.zoom,
    bearing: parsed.bearing ?? DEFAULT_VIEWPORT.bearing ?? 0,
    pitch: parsed.pitch ?? DEFAULT_VIEWPORT.pitch ?? 0,
  };
}

/**
 * Should the route fit {@link EmbedParams.bounds} instead of using the camera?
 *
 * Only when a span was given AND no explicit zoom was: `zoom` is the more
 * precise of the two instructions, so an embedder who sent both gets the one
 * that says exactly what they want rather than the one that approximates it.
 */
export function shouldFitBounds(parsed: EmbedParams): boolean {
  return parsed.bounds !== undefined && parsed.zoom === undefined;
}

/**
 * Should the route move the camera onto a resolved `place=`?
 *
 * Two rules, and both have already been got wrong once.
 *
 * **An explicit camera wins.** `?place=X&center=Y` means "show the area around
 * Y, and mark X"; moving to X would overrule an instruction the embedder gave
 * with one GoWay inferred. A `span=` counts as that instruction too, which is
 * why `bounds` is checked and not just `center`.
 *
 * **The canvas has to exist first.** Both `MapCanvas` forks hand out their
 * imperative handle from the first render — before their engine is built — and
 * both `moveTo`s return silently when the engine is not there yet. A move made
 * too early is therefore not queued, it is discarded, and a `place=` that
 * resolves from cache resolves BEFORE the style loads. The single move is
 * spent into nothing and the embed sits at the default viewport with the
 * marker it was asked to show possibly off screen. So the answer is `false`
 * until the canvas has reported ready, and the caller asks again when it has.
 */
export function shouldCentreOnPlace(
  parsed: EmbedParams,
  options: { placeResolved: boolean; canvasReady: boolean },
): boolean {
  if (!options.canvasReady || !options.placeResolved) return false;
  return parsed.center === undefined && parsed.bounds === undefined;
}
