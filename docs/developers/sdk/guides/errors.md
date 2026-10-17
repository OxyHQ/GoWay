# Errors

Every failure the SDK reports is a typed error that extends `GoWayError`, with a stable `code`, the HTTP `status` (or `null`), and a `retryable` flag that says whether repeating the same request later may succeed. This guide covers the classes, how to branch on them, validation before sending, cancellation and timeouts, and retrying.

## Branch on the class or the code

```ts
import {
  GoWayError,
  GoWayGoneError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayUnavailableError,
  GoWayValidationError,
} from '@goway.to/sdk';

try {
  const place = await goway.places.get(placeId);
  show(place);
} catch (error) {
  if (error instanceof GoWayGoneError) {
    error.mergedInto ? replaceStoredId(placeId, error.mergedInto) : forgetStoredId(placeId);
  } else if (error instanceof GoWayNotFoundError) {
    showMessage('This place is not available');
  } else if (error instanceof GoWayValidationError) {
    console.error('Bad input:', error.message); // a bug in the caller
  } else if (error instanceof GoWayUnavailableError || error instanceof GoWayRateLimitError) {
    showMessage('Temporarily unavailable, try again shortly');
  } else if (error instanceof GoWayError) {
    console.error(error.toJSON());
  } else {
    throw error;
  }
}
```

Never branch on `message`; it is for people. `code` and the class are the contract. `instanceof` works even when your app loads two copies of the SDK (an ESM and a CommonJS build); `isGoWayError(value)` does the same check as a type guard.

## The classes

| Class | `code` | `retryable` | When |
| --- | --- | --- | --- |
| `GoWayValidationError` | `validation_failed`, `bad_request` | no | Input refused, before sending (`status: null`) or by the API (400, 422). |
| `GoWayUnauthorizedError` | `unauthorized` | no | 401: a token was required and missing, expired or invalid. |
| `GoWayForbiddenError` | `forbidden` | no | 403: signed in but not allowed. |
| `GoWayNotFoundError` | `not_found` | no | 404 from GoWay: no such resource, or you may not see it. |
| `GoWayGoneError` | `gone` | no | 410: a place that existed was removed, or merged (`mergedInto`). |
| `GoWayConflictError` | `conflict` | no | 409: the write conflicts with current state. |
| `GoWayNoRouteError` | `no_route` | no | No route exists between the points. A normal answer. |
| `GoWayUnsupportedModeError` | `unsupported_mode` | no | The travel mode is not covered here. A normal answer. |
| `GoWayUnknownRouteError` | `unknown_route` | no | The API has no such endpoint: the SDK is newer than the deployment, or `apiBaseUrl` is wrong. |
| `GoWayRateLimitError` | `rate_limited` | yes | 429. `retryAfterSeconds` when GoWay said. |
| `GoWayUnavailableError` | `provider_unavailable`, `service_unavailable`, `internal_error` | yes, except `internal_error` | An upstream provider or GoWay itself could not answer. |
| `GoWayNetworkError` | `network_error` | yes | The request did not complete: offline, DNS, TLS, reset. |
| `GoWayTimeoutError` | `timeout` | yes | The request outlived `timeoutMs`. Extends `GoWayNetworkError`. |
| `GoWayAbortError` | `aborted` | no | You aborted it with your `AbortSignal`. |
| `GoWayResponseError` | `malformed_response` | no | The response did not match the contract. |
| `GoWayApiError` | `http_error` | no (yes for 408) | Any other non-2xx response. `GoWayNoRouteError`, `GoWayUnsupportedModeError` and `GoWayUnknownRouteError` extend it. |

`ApiErrorCode` (`API_ERROR_CODES`) is the API's own vocabulary; `GoWayErrorCode` adds the client-side codes `network_error`, `timeout`, `aborted`, `malformed_response` and `http_error`.

### Not found, gone and unknown route are different answers

- `GoWayNotFoundError` is raised only when the response is a genuine GoWay error body. A bare 404 from a proxy becomes a `GoWayApiError`, so you never drop a stored place id because of a misrouted request.
- `GoWayGoneError` means the id was real and is retired. It is not a subclass of `GoWayNotFoundError`. When the place was merged, `mergedInto` holds the id to store instead (it is read from `details.mergedInto`, the key `GONE_MERGED_INTO_DETAIL`).
- `GoWayUnknownRouteError` is about the API, never about the resource. It is not a `GoWayNotFoundError` either.

### "No route" is not a failure

`GoWayNoRouteError` and an empty `routes` array both mean "no route found". Render them as such, not as "something went wrong". See [Routing](./routing.md).

## Validation before sending

Every method checks its input against the same contract the API validates with, before any request leaves. A refused input throws `GoWayValidationError` with `status: null` and a message naming the path and the rule, never the value (so a user's location never ends up in your error tracker):

```ts
try {
  await goway.places.nearby({ latitude: 95, longitude: 2.17, radiusMeters: 500 });
} catch (error) {
  if (error instanceof GoWayValidationError && error.status === null) {
    console.log(error.message); // 'query.latitude: ...'
  }
}
```

Construction errors are different: `createGoWayClient` throws a plain `TypeError` for an invalid option, and so does a call when no `fetch` exists in the runtime. Those are programming errors to fix, not conditions to handle.

The SDK also parses every response. A body that does not match the contract becomes a `GoWayResponseError`; unknown fields are stripped rather than passed through.

## Cancellation and timeouts

Every method takes `{ signal }` as its last argument. Aborting rejects the call with `GoWayAbortError`. A signal already aborted rejects before anything is sent.

```ts
const controller = new AbortController();
const pending = goway.search.query({ query: 'bakery' }, { signal: controller.signal });
controller.abort();
await pending.catch((error) => {
  if (!(error instanceof GoWayAbortError)) throw error;
});
```

Each request also has a timeout, `timeoutMs` on the client (default `DEFAULT_GOWAY_TIMEOUT_MS`, 15 seconds), covering the token getter, the request and reading the body. A timeout rejects with `GoWayTimeoutError`. Both are enforced by the SDK itself, so they hold even with a custom `fetch` that ignores `signal`.

## Retrying

The SDK never retries by itself. Use `retryable` to decide, and back off:

```ts
import { GoWayRateLimitError, isGoWayError } from '@goway.to/sdk';

async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isGoWayError(error) || !error.retryable || attempt >= attempts) throw error;
      const waitSeconds =
        error instanceof GoWayRateLimitError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds
          : 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}

const results = await withRetry(() => goway.search.query({ query: 'pharmacy' }));
```

For an API error, `retryable` is `API_ERROR_RETRYABLE[code]`, the API's own answer: only `rate_limited`, `provider_unavailable` and `service_unavailable` are worth repeating. `internal_error` shares `GoWayUnavailableError` with them but is not retryable.

`GoWayRateLimitError.retryAfterSeconds` comes from the error body when GoWay sent one, otherwise from the `Retry-After`, `RateLimit-Reset` or `RateLimit` header, otherwise `null`.

## Logging

`error.toJSON()` returns `{ name, code, status, retryable, message, details }` (plus `mergedInto` or `retryAfterSeconds` on those classes). It carries no stack, no cause, no request data and no token, so it is safe to send to an error tracker. Server-supplied message text is flattened to one line and capped at 200 characters.

## See also

- [Errors example](../examples/handle-errors.md)
- [API reference: Errors](../api-reference/index.md#errors)
