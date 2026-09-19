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

- [`SDK_VISION.md`](SDK_VISION.md) — what `@goway.to/sdk` is for, and who for.
- [`CONTRIBUTING_SCOPE.md`](CONTRIBUTING_SCOPE.md) — what the first release
  prioritizes, and what is deliberately deferred.
