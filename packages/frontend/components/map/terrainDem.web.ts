import type { AddProtocolAction } from 'maplibre-gl';

let serial = 0;
/** One DEM for terrain, hillshade and every object grounded by the map. */
export function terrainDemProtocol(options: {
  template: string;
  roads: string;
  cacheTiles: number;
  addProtocol: (name: string, load: AddProtocolAction) => void;
  removeProtocol: (name: string) => void;
}) {
  const name = `goway-terrain-${++serial}`;
  const worker = new Worker(new URL('./engine/terrain/terrainWorker', import.meta.url));
  let next = 0;
  const pending = new Map<
    number,
    {
      resolve: (data: { data: ArrayBuffer }) => void;
      reject: (error: Error) => void;
      clean: () => void;
    }
  >();
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    task.clean();
    if (data.error) task.reject(Object.assign(new Error(data.error), { status: data.status }));
    else task.resolve({ data: data.bytes });
  };
  worker.onerror = (event) => {
    for (const task of pending.values()) {
      task.clean();
      task.reject(new Error(event.message));
    }
    pending.clear();
  };
  options.addProtocol(
    name,
    (request, abort) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const cancel = () => {
          pending.delete(id);
          worker.postMessage({ cancel: id });
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (abort.signal.aborted) {
          cancel();
          return;
        }
        abort.signal.addEventListener('abort', cancel, { once: true });
        pending.set(id, {
          resolve,
          reject,
          clean: () => abort.signal.removeEventListener('abort', cancel),
        });
        worker.postMessage({
          id,
          url: request.url.slice(name.length + 3),
          roads: options.roads,
          cacheTiles: options.cacheTiles,
        });
      }),
  );
  return {
    template: `${name}://${options.template}`,
    setCacheTiles(tiles: number) {
      options.cacheTiles = tiles;
      worker.postMessage({ cacheTiles: tiles });
    },
    dispose() {
      options.removeProtocol(name);
      worker.terminate();
      for (const task of pending.values()) {
        task.clean();
        task.reject(new DOMException('Disposed', 'AbortError'));
      }
      pending.clear();
    },
  };
}
