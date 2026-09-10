# GoWay SDK vision

The SDK should let any Oxy or third-party app consume GoWay maps, Places, search and routing without depending directly on MapLibre or any map/geocoding/routing provider.

Target package: **`@goway.to/sdk`**

This follows the same product-owned package convention as `@syra.fm/sdk` and `@clarity.surf/sdk`: GoWay owns the geographic platform contract even when the primary consumers are other Oxy products.

Core areas:

- Map rendering primitives
- Markers and annotations
- Camera / viewport control
- Places search, nearby queries and place details
- GoWay Places types and capability filters
- Geocoding / reverse geocoding
- Directions and route geometry
- Layer composition
- Provider adapters behind stable GoWay contracts
- Shared TypeScript types

Example consumers include GoWay, FairCoin Wallet, Moovo, Mercaria, Homiio, Mention and Clarity.
