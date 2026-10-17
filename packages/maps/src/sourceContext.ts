/** The id of the source a `<Layer>` draws: the `<GeoJSONSource>` / `<RasterDEMSource>` around it. */
import { createContext, useContext } from 'react';

export const SourceIdContext = createContext<string | null>(null);

export function useSourceId(): string {
  const id = useContext(SourceIdContext);
  if (!id)
    throw new Error(
      'A <Layer> must be rendered inside a source (<GeoJSONSource>, <RasterDEMSource>).',
    );
  return id;
}
