/**
 * The single place a failure becomes a response.
 *
 * Routes THROW; nothing formats an error itself. That is what keeps the error
 * envelope a contract rather than a convention — a `@goway.to/sdk` consumer's
 * retry logic branches on these codes, so a handler that answers its own shape
 * silently changes what a caller does with a failure.
 */

import {
  accessErrorStatus,
  appPermissionErrorStatus,
  OxyAccessError,
  OxyAppPermissionError,
} from '@oxy.so/core/server';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError, isApiError } from './apiError';
import { logger } from '../utils/logger';

/**
 * Translates the body parser's own failures.
 *
 * `express.json` rejects an oversized or malformed body before any route runs,
 * with an error carrying a `type`. Left unclassified it surfaces as a 500 —
 * telling an integrator that GoWay broke when in fact their payload did, and
 * inviting the retry that `service_unavailable` is reserved for.
 */
function bodyParserFailure(error: unknown): ApiError | null {
  if (typeof error !== 'object' || error === null || !('type' in error)) return null;

  switch ((error as { type: unknown }).type) {
    case 'entity.too.large':
      return new ApiError('payload_too_large', 'The request body exceeds the size limit.');
    case 'entity.parse.failed':
      return new ApiError('bad_request', 'The request body is not valid JSON.');
    case 'encoding.unsupported':
      return new ApiError('bad_request', 'The request body uses an unsupported encoding.');
    default:
      return null;
  }
}

/**
 * Translates `@oxy.so/core`'s typed authority refusals — an account or
 * application-permission read as the caller (`oxy/accountAccess`,
 * `oxy/appPermissions`) — by the status the SDK maps each to: no session is
 * `unauthorized`, a definitive no is `forbidden`, Oxy unable to say is
 * `service_unavailable` (never a "no"), and a GoWay misconfiguration is
 * `internal_error`. The SDK's message stays in the log, never in the response.
 */
function oxyAuthorityFailure(error: unknown): ApiError | null {
  let status: number;
  if (error instanceof OxyAccessError) status = accessErrorStatus(error);
  else if (error instanceof OxyAppPermissionError) status = appPermissionErrorStatus(error, 403);
  else return null;
  switch (status) {
    case 401:
      return new ApiError('unauthorized', 'Your Oxy session is no longer valid. Sign in again.');
    case 403:
      return new ApiError('forbidden', 'Your Oxy account may not do this.');
    case 503:
      return new ApiError(
        'service_unavailable',
        'Access cannot be checked right now because Oxy is unavailable. Try again shortly.',
      );
    default:
      return null;
  }
}

/**
 * Answers any request that matched no route — `unknown_route`, not
 * `not_found`. A client that sees it is talking to an API older or newer than
 * it was built for; telling it "not found" would have it conclude a resource
 * is gone and drop an id it should have kept.
 */
export const unknownRouteHandler: RequestHandler = (_request, response) => {
  response
    .status(404)
    .json(new ApiError('unknown_route', 'No route matches this request.').toResponseBody());
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  // Express recognises an error handler only by the four-argument shape, and
  // delegates to its default once a response has begun.
  if (response.headersSent) {
    next(error);
    return;
  }

  const apiError = isApiError(error)
    ? error
    : (bodyParserFailure(error) ?? oxyAuthorityFailure(error));

  if (apiError) {
    if (apiError.status === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="goway"');
    }
    if (apiError.status >= 500) {
      // A 503 is the service telling a caller to retry; an operator has to see
      // it, unlike an ordinary 4xx which is the caller's own doing.
      logger.error(
        {
          classification: 'api_error',
          code: apiError.code,
          method: request.method,
          path: request.path,
        },
        'Request failed with a server-side condition',
      );
    }
    response.status(apiError.status).json(apiError.toResponseBody());
    return;
  }

  // Anything else is a DEFECT. Its message, stack and own properties can carry
  // a query string, a coordinate or a driver detail, so the log line gets fixed
  // classification fields plus the error under `err` — which pino's redaction
  // list covers — and the RESPONSE gets none of it.
  logger.error(
    {
      classification: 'unexpected_error',
      code: 'internal_error',
      method: request.method,
      path: request.path,
      err: error,
    },
    'Unhandled request error',
  );
  const internalError = new ApiError('internal_error', 'The request could not be completed.');
  response.status(internalError.status).json(internalError.toResponseBody());
};
