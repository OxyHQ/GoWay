/**
 * The camera along a route: on the route, looking ahead, slower in turns,
 * continuous from frame to frame (so scrubbing and playback agree), and
 * adapting its flight time and zoom to the route's length.
 */
import { describe, expect, test } from 'bun:test';

import { bearingDelta, createPlane, metresPerPixel } from '@/lib/map/camera/plane';
import { cruiseZoom, followSeconds, planRouteFlyover } from '@/lib/map/camera/routeFlyover';
import { distanceMeters } from '@goway.to/sdk/geo';

const VIEWPORT = { width: 1000, height: 700 };
const ORIGIN = { latitude: 41.3874, longitude: 2.1686 };
const plane = createPlane(ORIGIN);
const at = (x: number, y: number) => plane.toGeo({ x, y });

/** East 600 m, then a right angle north 600 m: one hard turn. */
const L_ROUTE = [
  at(0, 0),
  at(200, 0),
  at(400, 0),
  at(600, 0),
  at(600, 200),
  at(600, 400),
  at(600, 600),
];

/** Distance from a point to the polyline, metres. */
function offRoute(point: { latitude: number; longitude: number }, line: typeof L_ROUTE): number {
  const p = plane.toPlane(point);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length - 1; i++) {
    const a = plane.toPlane(line[i]);
    const b = plane.toPlane(line[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe('planRouteFlyover', () => {
  const plan = planRouteFlyover({ coordinates: L_ROUTE, viewport: VIEWPORT });
  if (!plan) throw new Error('expected a plan');

  test('the vehicle drives the route', () => {
    for (let t = 0; t <= plan.durationMs; t += 250) {
      // Within a couple of metres: only the turn is rounded.
      expect(offRoute(plan.frameAt(t).vehicle.position, L_ROUTE)).toBeLessThan(3);
    }
    expect(plan.lengthMeters).toBeCloseTo(1200, -1);
  });

  test('distance only ever goes forward, from 0 to the end', () => {
    let previous = -1;
    for (let t = 0; t <= plan.durationMs; t += 50) {
      const d = plan.frameAt(t).distanceMeters;
      expect(d).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = d;
    }
    expect(plan.frameAt(0).distanceMeters).toBe(0);
    expect(plan.frameAt(plan.durationMs).distanceMeters).toBeCloseTo(plan.lengthMeters, 6);
  });

  test('takes off from a top-down overview and lands on a tilted one', () => {
    const first = plan.frameAt(0);
    expect(first.phase).toBe('takeoff');
    expect(first.camera.pitch).toBe(0);
    const last = plan.frameAt(plan.durationMs);
    expect(last.phase).toBe('landing');
    expect(last.camera.pitch).toBe(45);
    // Both overviews show the whole route: further out than the chase camera.
    const chase = plan.frameAt(plan.durationMs / 2).camera.zoom;
    expect(first.camera.zoom).toBeLessThan(chase);
    expect(last.camera.zoom).toBeLessThan(chase);
  });

  test('looks ahead: on the first leg it faces east, on the second north', () => {
    const follow = [];
    for (let t = 0; t <= plan.durationMs; t += 100) {
      const f = plan.frameAt(t);
      if (f.phase === 'follow') follow.push(f);
    }
    const early = follow.find((f) => f.distanceMeters > 100 && f.distanceMeters < 200);
    const late = follow.find((f) => f.distanceMeters > 1000);
    expect(Math.abs(bearingDelta(early?.camera.bearing ?? 0, 90))).toBeLessThan(12);
    expect(Math.abs(bearingDelta(late?.camera.bearing ?? 90, 0))).toBeLessThan(12);
    // ... and BEFORE the corner it is already turning toward the new leg.
    const before = follow.find((f) => f.distanceMeters > 560 && f.distanceMeters < 590);
    const turning = bearingDelta(90, before?.camera.bearing ?? 90);
    expect(turning).toBeLessThan(-5);
    // The vehicle itself faces along the road, not where the camera looks.
    expect(Math.abs(bearingDelta(early?.vehicle.heading ?? 0, 90))).toBeLessThan(2);
  });

  test('slows down in the turn', () => {
    const speedAround = (metres: number) => {
      let t0 = 0;
      for (let t = 0; t <= plan.durationMs; t += 10) {
        if (plan.frameAt(t).distanceMeters >= metres) {
          t0 = t;
          break;
        }
      }
      return (plan.frameAt(t0 + 200).distanceMeters - plan.frameAt(t0).distanceMeters) / 0.2;
    };
    expect(speedAround(600)).toBeLessThan(speedAround(250) * 0.8);
  });

  test('the camera is continuous: no frame-to-frame jump at 60 fps', () => {
    let previous = plan.frameAt(0).camera;
    for (let t = 16; t <= plan.durationMs; t += 16) {
      const camera = plan.frameAt(t).camera;
      const moved = distanceMeters(previous, camera);
      // Never more than ~25 screen px in one frame, at the zoom of the frame.
      expect(moved / metresPerPixel(camera.latitude, camera.zoom)).toBeLessThan(25);
      expect(Math.abs(bearingDelta(previous.bearing, camera.bearing))).toBeLessThan(3);
      expect(Math.abs(camera.zoom - previous.zoom)).toBeLessThan(0.08);
      previous = camera;
    }
  });

  test('scrubbing is deterministic', () => {
    expect(plan.frameAt(7_777)).toEqual(plan.frameAt(7_777));
  });

  test('chapters are sorted, inside the flight, and include the turn', () => {
    const chapters = plan.chapters;
    expect(chapters[0]).toBe(0);
    expect(chapters[chapters.length - 1]).toBe(plan.durationMs);
    for (let i = 1; i < chapters.length; i++) expect(chapters[i]).toBeGreaterThan(chapters[i - 1]);
    const nearTurn = chapters.some((t) => Math.abs(plan.frameAt(t).distanceMeters - 600) < 80);
    expect(nearTurn).toBe(true);
  });

  test('maneuver indices become chapters', () => {
    const withManeuvers = planRouteFlyover({
      coordinates: L_ROUTE,
      viewport: VIEWPORT,
      chapterIndices: [3],
    });
    const hit = withManeuvers?.chapters.some(
      (t) => Math.abs((withManeuvers?.frameAt(t).distanceMeters ?? 0) - 600) < 5,
    );
    expect(hit).toBe(true);
  });
});

describe('adapting to length', () => {
  test('longer routes fly longer and higher, within bounds', () => {
    expect(followSeconds(300)).toBeLessThan(followSeconds(1200));
    expect(followSeconds(1200)).toBeLessThan(followSeconds(10_000));
    expect(followSeconds(1_000_000)).toBe(60);
    expect(followSeconds(1)).toBe(12);
    expect(cruiseZoom(300)).toBeGreaterThan(cruiseZoom(10_000));
    expect(cruiseZoom(10_000_000)).toBe(14.5);
  });

  test('a 25 km route plans and stays smooth', () => {
    const line = Array.from({ length: 200 }, (_, i) => at(i * 125, Math.sin(i / 7) * 400));
    const plan = planRouteFlyover({ coordinates: line, viewport: VIEWPORT });
    expect(plan).not.toBeNull();
    expect(plan?.durationMs).toBeLessThanOrEqual((60 + 6.5) * 1000);
  });
});

describe('degenerate input', () => {
  test('nothing to fly is null, never a throw', () => {
    expect(planRouteFlyover({ coordinates: [], viewport: VIEWPORT })).toBeNull();
    expect(planRouteFlyover({ coordinates: [ORIGIN], viewport: VIEWPORT })).toBeNull();
    expect(
      planRouteFlyover({ coordinates: [ORIGIN, ORIGIN, ORIGIN], viewport: VIEWPORT }),
    ).toBeNull();
    expect(
      planRouteFlyover({
        coordinates: [{ latitude: Number.NaN, longitude: 2 }, ORIGIN],
        viewport: VIEWPORT,
      }),
    ).toBeNull();
  });

  test('non-finite vertices are dropped, not drawn', () => {
    const plan = planRouteFlyover({
      coordinates: [
        L_ROUTE[0],
        { latitude: Number.NaN, longitude: Number.NaN },
        ...L_ROUTE.slice(1),
      ],
      viewport: VIEWPORT,
    });
    expect(plan).not.toBeNull();
    const frame = plan?.frameAt(Number.NaN);
    expect(Number.isFinite(frame?.camera.latitude)).toBe(true);
  });
});
