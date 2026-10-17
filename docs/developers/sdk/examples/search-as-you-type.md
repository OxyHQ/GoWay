# Search as you type

A search box that queries GoWay as the user types: it waits for a short pause, cancels the previous request when the text changes, skips empty input, and biases results toward the visible map. The controller is plain TypeScript with no UI framework, so you can wire it to any input.

```ts
import {
  createGoWayClient,
  GoWayAbortError,
  GoWayRateLimitError,
  GoWayUnavailableError,
  type GeoBoundingBox,
  type SearchResult,
} from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

export interface SearchBox {
  /** Call on every keystroke. */
  setText(text: string): void;
  /** Call when the map moves, so results favour what is on screen. */
  setViewport(viewport: GeoBoundingBox | undefined): void;
  dispose(): void;
}

export function createSearchBox(
  onResults: (results: SearchResult[], partial: boolean) => void,
  onError: (message: string) => void,
  debounceMs = 250,
): SearchBox {
  let viewport: GeoBoundingBox | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;

  async function run(text: string) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const page = await goway.search.query(
        { query: text, limit: 8, ...(viewport ? { viewport } : {}) },
        { signal: controller.signal },
      );
      onResults(page.items, (page.degradedProviders ?? []).length > 0);
    } catch (error) {
      if (error instanceof GoWayAbortError) return; // superseded by newer text
      if (error instanceof GoWayUnavailableError || error instanceof GoWayRateLimitError) {
        onError('Search is temporarily unavailable.');
        return;
      }
      throw error;
    }
  }

  return {
    setText(text) {
      if (timer !== undefined) clearTimeout(timer);
      const trimmed = text.trim();
      if (trimmed === '') {
        inFlight?.abort();
        onResults([], false);
        return;
      }
      timer = setTimeout(() => {
        run(trimmed).catch((error: unknown) => onError(String(error)));
      }, debounceMs);
    },
    setViewport(next) {
      viewport = next;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      inFlight?.abort();
    },
  };
}

// Usage
const box = createSearchBox(
  (results, partial) => {
    for (const result of results) console.log(result.kind, result.displayName);
    if (partial) console.log('(some sources did not answer)');
  },
  (message) => console.warn(message),
);

box.setViewport({ west: 2.12, south: 41.36, east: 2.22, north: 41.42 });
box.setText('sagrada');
```

Notes:

- An empty query is refused with `GoWayValidationError` before sending, which is why the box checks `trim()` first.
- Aborting rejects the old call with `GoWayAbortError`; ignoring it is correct, because a newer request is on its way.
- `viewport` only re-ranks results; it does not filter them. Use `near` instead to bias toward the user's position.
- A result with a `placeId` is a GoWay place: open it with `goway.places.get(result.placeId)` or link it with `goway.links.place(result)`.

See the [Search guide](../guides/search.md).
