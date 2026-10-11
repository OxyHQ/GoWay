# Models served from `/models/`

Every 3D asset here is listed with its source and licence. GoWay ships only
models whose licence it has checked, one by one (`docs/SDK_MAP_MODELS.md` →
"Assets: one format").

| File | Source | Licence | Credit |
| --- | --- | --- | --- |
| `library/*.glb` (the model library, `lib/map/modelLibrary.ts`) | Built by `packages/frontend/scripts/build-model-library.ts` from [Kenney](https://kenney.nl)'s Car Kit 3.1, Train Kit 1.1 and Watercraft Kit 2.1 (each verified CC0 in its `License.txt` and on its page), recoloured and rescaled, wheels redrawn low-poly, a far level of boxes added; `vehicle.bus`, `vehicle.bus-double` and `aircraft.airliner` are GoWay's own geometry (`scripts/library/`). Per-file source, licence and hash: `library/manifest.json` | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None required (Kenney credited on `/attribution` anyway) |
