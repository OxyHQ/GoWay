# Handle errors

One function that turns any GoWay failure into what your UI should do: show a message, retry with backoff, update a stored id, or report a bug. It uses the error classes and the `retryable` flag rather than parsing messages, and logs with `toJSON()`, which never includes a token or request data.

```ts
import {
  createGoWayClient,
  GoWayAbortError,
  GoWayError,
  GoWayGoneError,
  GoWayNoRouteError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayUnauthorizedError,
  GoWayUnknownRouteError,
  GoWayUnsupportedModeError,
  GoWayValidationError,
  isGoWayError,
  type Place,
} from '@goway.to/sdk';

const goway = createGoWayClient({ timeoutMs: 10_000 });

type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'moved'; placeId: string }
  | { kind: 'missing' }
  | { kind: 'message'; text: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt<T>(call: () => Promise<T>, maxAttempts = 3): Promise<Outcome<T>> {
  for (let tries = 1; ; tries++) {
    try {
      return { kind: 'ok', value: await call() };
    } catch (error) {
      if (!isGoWayError(error)) throw error; // not from the SDK: a bug in our own code

      if (error.retryable && tries < maxAttempts) {
        const seconds =
          error instanceof GoWayRateLimitError && error.retryAfterSeconds !== null
            ? error.retryAfterSeconds
            : 2 ** tries;
        await sleep(seconds * 1000);
        continue;
      }
      return describe(error);
    }
  }
}

function describe(error: GoWayError): Outcome<never> {
  if (error instanceof GoWayGoneError) {
    return error.mergedInto ? { kind: 'moved', placeId: error.mergedInto } : { kind: 'missing' };
  }
  if (error instanceof GoWayNotFoundError) return { kind: 'missing' };
  if (error instanceof GoWayNoRouteError) return { kind: 'message', text: 'No route found.' };
  if (error instanceof GoWayUnsupportedModeError) return { kind: 'message', text: 'Try another travel mode.' };
  if (error instanceof GoWayUnauthorizedError) return { kind: 'message', text: 'Please sign in again.' };
  if (error instanceof GoWayAbortError) return { kind: 'message', text: '' };
  if (error instanceof GoWayUnknownRouteError) {
    console.error('SDK and API disagree; check apiBaseUrl or upgrade', error.toJSON());
    return { kind: 'message', text: 'Something went wrong.' };
  }
  if (error instanceof GoWayValidationError && error.status === null) {
    console.error('Invalid input sent to GoWay', error.toJSON());
    return { kind: 'message', text: 'Something went wrong.' };
  }
  if (error.retryable) return { kind: 'message', text: 'GoWay is temporarily unavailable. Try again shortly.' };

  console.error('GoWay request failed', error.toJSON());
  return { kind: 'message', text: 'Something went wrong.' };
}

// Usage: open a stored place, following a merge.
async function openStoredPlace(placeId: string): Promise<Place | null> {
  const outcome = await attempt(() => goway.places.get(placeId));
  switch (outcome.kind) {
    case 'ok':
      return outcome.value;
    case 'moved':
      console.log(`Place ${placeId} was merged; storing ${outcome.placeId} instead.`);
      return openStoredPlace(outcome.placeId);
    case 'missing':
      console.log(`Place ${placeId} is not available.`);
      return null;
    case 'message':
      if (outcome.text) console.log(outcome.text);
      return null;
  }
}

openStoredPlace('gw_place_01H8').then((place) => console.log(place?.name ?? 'none'));
```

Notes:

- Only `GoWayRateLimitError`, `GoWayNetworkError`, `GoWayTimeoutError` and `GoWayUnavailableError` (for `provider_unavailable` and `service_unavailable`) are `retryable`. The SDK never retries on its own.
- A merged place points one hop to its survivor (`mergedInto`), so following it once is enough.
- `GoWayValidationError` with `status: null` was raised before anything was sent: fix the input rather than retrying.

See the [Errors guide](../guides/errors.md).
