/**
 * An attached plugin's props, bound with its `update` (see `MapPlugin.web.tsx`).
 */
import { useLayoutEffect, useRef } from 'react';

import type { MapPluginHandle } from './plugin';

export function PluginProps<Props>({
  handle,
  attachedWith,
  props,
}: {
  handle: MapPluginHandle<Props>;
  /** The props `attach` received. */
  attachedWith: Props;
  props: Props;
}) {
  // The props the handle has: those it was attached with, then each update.
  const delivered = useRef<{ handle: MapPluginHandle<Props>; props: Props }>({
    handle,
    props: attachedWith,
  });
  // Binding: an attached plugin receives every new `props`.
  useLayoutEffect(() => {
    const last =
      delivered.current.handle === handle ? delivered.current : { handle, props: attachedWith };
    if (last.props !== props) handle.update?.(props);
    delivered.current = { handle, props };
  }, [handle, attachedWith, props]);
  return null;
}
