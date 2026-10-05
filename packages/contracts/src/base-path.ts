/**
 * The path every public GoWay API route hangs off.
 *
 * Versioned in the PATH rather than in a header so a cached URL is a complete
 * description of what was requested, and so a consumer pinned to v1 keeps
 * working when v2 ships beside it.
 *
 * Its own module so a client that needs only this string does not bundle the
 * route registry beside it.
 */
export const GOWAY_API_BASE_PATH = '/api/v1';
