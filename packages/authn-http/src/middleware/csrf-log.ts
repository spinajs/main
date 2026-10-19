// Kept apart from csrf.ts so the shipped config can import it without loading the middleware.

/** The `event` variable of a CsrfOriginGuard refusal line; the shipped `logger.filters` limit lines by it. */
export const CSRF_REFUSED_EVENT = 'authn-http.csrf-refused';

/**
 * One line per (Origin, own origin) pair a minute, and 20 a minute in all, so requests that vary the headers cannot
 * turn refusals into one log line each.
 */
export const CSRF_REFUSAL_LOG_FILTERS = [
  { type: 'RateLimitFilter', logger: 'authn-http', where: { event: CSRF_REFUSED_EVENT }, key: ['origin', 'ownOrigin'], limit: 1, intervalSeconds: 60, maxKeys: 256 },
  { type: 'RateLimitFilter', logger: 'authn-http', where: { event: CSRF_REFUSED_EVENT }, limit: 20, intervalSeconds: 60 },
];
