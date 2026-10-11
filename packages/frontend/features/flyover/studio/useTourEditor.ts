/**
 * Camera Studio's editing state: a tour under an undo/redo history.
 *
 * Every edit goes through `lib/map/camera/history.ts`, one step per gesture:
 * a drawn stroke is one `push`, a slider drag is one `begin … preview …
 * commit`, a button is one `push`. The selected keyframe is UI state, not
 * history — undo takes back edits, not clicks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GeoCoordinate, ResolvedMapViewport } from '@/components/map/types';
import {
  begin,
  canRedo,
  canUndo,
  commit,
  createHistory,
  type History,
  preview,
  push,
  redo,
  undo,
} from '@/lib/map/camera/history';
import { createPlane, metresPerPixel } from '@/lib/map/camera/plane';
import { simplify } from '@/lib/map/camera/spline';
import {
  compileTour,
  MAX_TOUR_KEYFRAMES,
  type Tour,
  type TourKeyframe,
} from '@/lib/map/camera/tour';

/** A keyframe without its session id, for building one. */
export type KeyframeInput = Omit<TourKeyframe, 'id'>;

/** Pitch a drawn path flies at. */
const DRAWN_PITCH = 55;
/** How much closer than the drawing view a drawn path flies. */
const DRAWN_ZOOM_IN = 1.5;
/** Simplification tolerance for a stroke, in screen pixels. */
const STROKE_TOLERANCE_PX = 10;

const EMPTY_TOUR: Tour = { keyframes: [], speed: 1 };

let nextId = 1;
const newId = () => `kf${nextId++}`;

export interface TourEditor {
  tour: Tour;
  compiled: ReturnType<typeof compileTour>;
  selectedId: string | null;
  select(id: string | null): void;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  /** Add a keyframe (after the selected one, else at the end) and select it. */
  addKeyframe(input: KeyframeInput): void;
  /** Append a drawn stroke (geographic points along it) as keyframes. */
  addStroke(points: readonly GeoCoordinate[], drawnAt: ResolvedMapViewport): void;
  /** A discrete change to one keyframe. */
  updateKeyframe(id: string, patch: Partial<KeyframeInput>): void;
  /** A continuous change (a slider drag): previewed, recorded on `endGesture`. */
  dragKeyframe(id: string, patch: Partial<KeyframeInput>): void;
  endGesture(): void;
  removeKeyframe(id: string): void;
  setSpeed(speed: number, gesture?: boolean): void;
  clear(): void;
  /** Replace the whole tour (a shared link), as one undoable step. */
  load(tour: Tour): void;
}

function patchKeyframe(tour: Tour, id: string, patch: Partial<KeyframeInput>): Tour {
  return {
    ...tour,
    keyframes: tour.keyframes.map((k) => (k.id === id ? { ...k, ...patch } : k)),
  };
}

export function useTourEditor(initial: Tour | null): TourEditor {
  const [history, setHistory] = useState<History<Tour>>(() =>
    createHistory(
      initial
        ? { ...initial, keyframes: initial.keyframes.map((k) => ({ ...k, id: newId() })) }
        : EMPTY_TOUR,
    ),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  });

  const tour = history.present;
  const compiled = useMemo(() => compileTour(tour), [tour]);

  const addKeyframe = useCallback((input: KeyframeInput) => {
    const keyframe: TourKeyframe = { ...input, id: newId() };
    setHistory((h) => {
      if (h.present.keyframes.length >= MAX_TOUR_KEYFRAMES) return h;
      const keyframes = [...h.present.keyframes];
      const after = keyframes.findIndex((k) => k.id === selectedRef.current);
      keyframes.splice(after >= 0 ? after + 1 : keyframes.length, 0, keyframe);
      return push(h, { ...h.present, keyframes });
    });
    setSelectedId(keyframe.id);
  }, []);

  const addStroke = useCallback(
    (points: readonly GeoCoordinate[], drawnAt: ResolvedMapViewport) => {
      if (points.length < 2) return;
      const plane = createPlane(points[0]);
      const tolerance = STROKE_TOLERANCE_PX * metresPerPixel(drawnAt.latitude, drawnAt.zoom);
      const planar = points.map((p) => ({ ...plane.toPlane(p), p }));
      // Fewest keyframes that keep the stroke's shape; coarser if the tour is full.
      setHistory((h) => {
        const room = MAX_TOUR_KEYFRAMES - h.present.keyframes.length;
        if (room < 2) return h;
        let factor = 1;
        let kept = simplify(planar, tolerance);
        while (kept.length > room && factor < 64) {
          factor *= 2;
          kept = simplify(planar, tolerance * factor);
        }
        const zoom = Math.min(19, drawnAt.zoom + DRAWN_ZOOM_IN);
        const added: TourKeyframe[] = kept.slice(0, room).map((k) => ({
          id: newId(),
          center: k.p,
          zoom,
          pitch: DRAWN_PITCH,
          bearing: drawnAt.bearing,
          aim: 'path',
          holdMs: 0,
        }));
        return push(h, { ...h.present, keyframes: [...h.present.keyframes, ...added] });
      });
    },
    [],
  );

  const updateKeyframe = useCallback((id: string, patch: Partial<KeyframeInput>) => {
    setHistory((h) => push(h, patchKeyframe(h.present, id, patch)));
  }, []);

  const dragKeyframe = useCallback((id: string, patch: Partial<KeyframeInput>) => {
    setHistory((h) =>
      preview(h.gestureStart === null ? begin(h) : h, patchKeyframe(h.present, id, patch)),
    );
  }, []);

  const endGesture = useCallback(() => setHistory((h) => commit(h)), []);

  const removeKeyframe = useCallback((id: string) => {
    setHistory((h) =>
      push(h, { ...h.present, keyframes: h.present.keyframes.filter((k) => k.id !== id) }),
    );
    setSelectedId((current) => (current === id ? null : current));
  }, []);

  const setSpeed = useCallback((speed: number, gesture = false) => {
    setHistory((h) =>
      gesture ? preview(h, { ...h.present, speed }) : push(h, { ...h.present, speed }),
    );
  }, []);

  const clear = useCallback(() => {
    setHistory((h) => push(h, { ...h.present, keyframes: [] }));
    setSelectedId(null);
  }, []);

  const load = useCallback((next: Tour) => {
    setHistory((h) =>
      push(h, { ...next, keyframes: next.keyframes.map((k) => ({ ...k, id: newId() })) }),
    );
    setSelectedId(null);
  }, []);

  return {
    tour,
    compiled,
    selectedId,
    select: setSelectedId,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undo: useCallback(() => setHistory((h) => undo(h)), []),
    redo: useCallback(() => setHistory((h) => redo(h)), []),
    addKeyframe,
    addStroke,
    updateKeyframe,
    dragKeyframe,
    endGesture,
    removeKeyframe,
    setSpeed,
    clear,
    load,
  };
}
