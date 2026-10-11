/**
 * A transparent surface over the map that turns a drag into a stroke.
 *
 * While it is mounted the map does not pan: the drag is the user's pen, not
 * a gesture on the map. The stroke is drawn live in screen pixels and handed
 * over on release; `StudioScreen` turns pixels into coordinates through the
 * top-down projection (`unprojectTopDown`), which is why draw mode levels the
 * camera first. Responder events, so it is the same component on web and
 * native.
 */
import { useRef, useState } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

export interface DrawSurfaceProps {
  /** Ink colour (the theme's accent). */
  color: string;
  onStroke: (
    points: readonly { x: number; y: number }[],
    size: { width: number; height: number },
  ) => void;
}

/** Ignore pointer moves closer than this to the last point, px. */
const MIN_STEP_PX = 3;

export function DrawSurface({ color, onStroke }: DrawSurfaceProps) {
  const [points, setPoints] = useState<readonly { x: number; y: number }[]>([]);
  const stroke = useRef<{ x: number; y: number }[]>([]);
  const size = useRef({ width: 0, height: 0 });

  const at = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.locationX,
    y: event.nativeEvent.locationY,
  });

  const add = (event: GestureResponderEvent) => {
    const p = at(event);
    const last = stroke.current[stroke.current.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP_PX) return;
    stroke.current.push(p);
    setPoints([...stroke.current]);
  };

  return (
    <View
      className="absolute inset-0"
      style={{ cursor: 'crosshair' } as object}
      onLayout={(event: LayoutChangeEvent) => {
        size.current = event.nativeEvent.layout;
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        stroke.current = [at(event)];
        setPoints(stroke.current);
      }}
      onResponderMove={add}
      onResponderRelease={() => {
        const drawn = stroke.current;
        stroke.current = [];
        setPoints([]);
        if (drawn.length >= 2) onStroke(drawn, size.current);
      }}
      accessibilityLabel="Drawing surface: drag to draw the camera path"
      testID="studio-draw-surface"
    >
      {points.length > 1 ? (
        <Svg width="100%" height="100%" pointerEvents="none">
          <Polyline
            points={points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="8 6"
          />
        </Svg>
      ) : null}
    </View>
  );
}
