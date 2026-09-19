/**
 * The single place a failure becomes a response.
 *
 * Routes THROW; nothing formats an error itself. That is what keeps the error
 * envelope a contract rather than a convention — a `@goway.to/sdk` consumer's
 * retry logic branches on these codes, so a handler that answers its own shape
 * silently changes what a caller does with a failure.
 */

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

/** Answers any request that matched no route. */
export const notFoundHandler: RequestHandler = (_request, response) => {
  response
    .status(404)
    .json(new ApiError('not_found', 'No route matches this request.').toResponseBody());
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  // Express recognises an error handler only by the four-argument shape, and
  // delegates to its default once a response has begun.
  if (response.headersSent) {
    next(error);
    return;
  }

  const apiError = isApiError(error) ? error : bodyParserFailure(error);

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
