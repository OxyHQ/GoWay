# Maps

Rules on top of the root `AGENTS.md`.

- Every map carries the GoWay mark bottom-left and the data credit bottom-right, drawn by `@goway.to/maps`'s `MapView` with no prop to disable — the embed included; the credit is OSMF-compact (`packages/maps/src/compactCredit.ts`).
- The logo is geometry (`packages/maps/src/brand/artwork.ts`), drawn and never fetched; `public/brand/*` is generated from it and gated by `brand:check`. Its blue is ink (`--color-brand-goway`), never Bloom's `--primary`.
