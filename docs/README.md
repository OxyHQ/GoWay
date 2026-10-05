# Documentation

This directory will hold product, SDK, API, data-model, privacy and integration documentation for GoWay.

## Integration guides

- [`integration/merchant-discovery.md`](integration/merchant-discovery.md) — how
  another app installs `@goway.to/sdk`, renders a GoWay map, queries nearby
  Places with a **capability filter**, presents the evidence behind a claim
  honestly, and opens the canonical `https://goway.to/place/<placeId>` link.
  FairCoin merchant discovery is the worked example; the mechanism is the
  generic one every Oxy product shares (`payments.*`, `commerce.mercaria.*`,
  `mobility.moovo.*`, `housing.homiio.*`).

## Design notes

- [`STREET3D_LIFECYCLE.md`](STREET3D_LIFECYCLE.md) — capture expiry, cleanup
  operations, crash recovery and the remaining Street 3D release gates.
- [`SDK_VISION.md`](SDK_VISION.md) — what `@goway.to/sdk` is for, and who for.
- [`CONTRIBUTING_SCOPE.md`](CONTRIBUTING_SCOPE.md) — what the first release
  prioritizes, and what is deliberately deferred.
- [`BUSINESS_OWNERSHIP.md`](BUSINESS_OWNERSHIP.md) — a business is an Oxy
  organization: who may act for a claim, the place history and what it never
  publishes, and the moderation surface, including how a merge redirects.
- [`PLACE_DATA.md`](PLACE_DATA.md) — the category taxonomy, the typed
  capability registry, the derived timezone and dated hours exceptions, and
  how the OpenStreetMap import keeps what it reads.
- [`PLACE_DATA_CONVERSION.md`](PLACE_DATA_CONVERSION.md) — the runbook for
  converting production's legacy categories and source statements in batches
  before the places-platform release, and what the previous image does meanwhile.
- [`PLACE_NAMES.md`](PLACE_NAMES.md) — how a place is named in more than one
  language, why `places.name` stayed, and what that means for duplicate
  detection, search, the SDK contract and the OpenStreetMap re-import.
