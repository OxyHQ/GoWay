/**
 * `<MapPlugin>`, web — the one place an app's engine plugin is bound to the
 * engine (`plugin.ts`).
 *
 * Attached once per engine and plugin (this file's binding), handed every new
 * `props` through `update` (`PluginProps.web.tsx`), detached on unmount or
 * when the engine is rebuilt. While attached it is consulted for presses, the
 * cursor and the errors of the sources it owns.
 */
import { useContext, useLayoutEffect, useState } from 'react';

import { type WebEngine, WebEngineContext } from './engineContext.web';
import type { MapPluginHandle, MapPluginProps } from './plugin';
import { PluginProps } from './PluginProps.web';
import { reportMapDefect } from './shared';

export function MapPlugin<Props>(props: MapPluginProps<Props>) {
  const engine = useContext(WebEngineContext);
  return engine ? <AttachedPlugin engine={engine} {...props} /> : null;
}

function AttachedPlugin<Props>({
  engine,
  plugin,
  props,
}: MapPluginProps<Props> & { engine: WebEngine }) {
  const [attachment, setAttachment] = useState<{
    handle: MapPluginHandle<Props>;
    props: Props;
  } | null>(null);
  // Binding: `plugin` is attached to the engine for as long as both are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a plugin is attached with the props of the render that attached it; later props reach it through `PluginProps`, never by re-attaching
  useLayoutEffect(() => {
    let attached: MapPluginHandle<Props> | null = null;
    try {
      attached = plugin.attach(engine.map, props, { container: engine.container });
    } catch (cause) {
      // A plugin that cannot attach costs the plugin, not the map.
      reportMapDefect('plugin:attach', `A map plugin failed to attach: ${String(cause)}`);
      return;
    }
    const registered = attached as MapPluginHandle<unknown>;
    engine.plugins.add(registered);
    setAttachment({ handle: attached, props });
    return () => {
      engine.plugins.delete(registered);
      setAttachment(null);
      attached?.detach();
    };
  }, [engine, plugin]);
  return attachment ? (
    <PluginProps handle={attachment.handle} attachedWith={attachment.props} props={props} />
  ) : null;
}
