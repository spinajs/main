import type { IncomingHttpHeaders } from 'node:http';
import * as express from 'express';
import { InvalidOption } from '@spinajs/exceptions';

import { HTTP_STATUS_CODE, ServerMiddleware, Request as sRequest } from '../interfaces.js';
import { parseOrigin } from './Cors.js';
import { requestOrigin, requestProxyTrust } from './RealIp.js';

/**
 * How a request without an Origin is judged.
 * - `same-origin-fetch`: only with `Sec-Fetch-Site: same-origin`; clients that send neither header are refused.
 * - `unless-cross-site`: refused only with `Sec-Fetch-Site: cross-site` or `same-site`; clients without fetch metadata
 *   (servers, older browsers) pass.
 */
export type MissingOriginRule = 'same-origin-fetch' | 'unless-cross-site';

/**
 * - `malformed-origin`: Origin is not a serialized origin (`null`, `*`, a path, ...).
 * - `foreign-origin`: Origin is neither the app's own origin nor an allowed one.
 * - `cross-site-fetch`: no Origin, and `Sec-Fetch-Site` says `cross-site` or `same-site`.
 * - `missing-origin`: no Origin and no `Sec-Fetch-Site: same-origin`, under `same-origin-fetch`.
 */
export type OriginRefusal = 'malformed-origin' | 'foreign-origin' | 'cross-site-fetch' | 'missing-origin';

export type OriginDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: OriginRefusal };

export interface SameOriginOptions {
  /** Origins accepted besides the app's own, normalised by {@link parseAllowedOrigins}. */
  allowedOrigins?: ReadonlySet<string>;
  /** Default `same-origin-fetch`. */
  missingOrigin?: MissingOriginRule;
}

const ALLOWED: OriginDecision = Object.freeze({ allowed: true });
const refused = (reason: OriginRefusal): OriginDecision => ({ allowed: false, reason });

/**
 * Whether a request comes from the app's own origin. With an Origin header, it must be `ownOrigin` (see
 * `requestOrigin`) or an allowed origin; without one, `Sec-Fetch-Site` decides, by `options.missingOrigin`.
 */
export function checkSameOrigin(headers: Readonly<Pick<IncomingHttpHeaders, 'origin' | 'sec-fetch-site'>>, ownOrigin: string | undefined, options: SameOriginOptions = {}): OriginDecision {
  const origin = headers.origin;
  if (origin === undefined) {
    const site = headers['sec-fetch-site'];
    if (site === 'same-origin') return ALLOWED;
    if (site === 'cross-site' || site === 'same-site') return refused('cross-site-fetch');
    return options.missingOrigin === 'unless-cross-site' ? ALLOWED : refused('missing-origin');
  }

  const parsed = parseOrigin(origin);
  if (parsed === undefined) return refused('malformed-origin');
  return parsed === parseOrigin(ownOrigin) || options.allowedOrigins?.has(parsed) ? ALLOWED : refused('foreign-origin');
}

/** Normalises allowed origin entries; an entry that is not an origin throws InvalidOption naming `key`. */
export function parseAllowedOrigins(entries: readonly string[] | null | undefined, key: string): ReadonlySet<string> {
  return new Set(
    (entries ?? []).map((entry) => {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`${key} entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port])`);
      return origin;
    }),
  );
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const REFUSED_BODY = Object.freeze({ error: Object.freeze({ code: 'E_ORIGIN_REFUSED', message: 'Cross-origin request refused' }) });

/**
 * Refuses cross-origin requests by {@link checkSameOrigin}, with the own origin from `requestOrigin` and the trust
 * `RealIp` resolved. Not registered: subclass it, narrow {@link appliesTo} and register the subclass with
 * `@Injectable(ServerMiddleware)`.
 */
export abstract class SameOriginGuard extends ServerMiddleware {
  protected MissingOrigin: MissingOriginRule = 'same-origin-fetch';

  constructor() {
    super();
    // After RealIp (1), which resolves the proxy trust.
    this.Order = 2;
  }

  /** Whether the request is checked at all; by default every method but GET, HEAD and OPTIONS. */
  protected appliesTo(req: sRequest): boolean {
    return !SAFE_METHODS.has(req.method);
  }

  /** Read once, when the middleware is built; use {@link parseAllowedOrigins} so a bad entry fails the boot. */
  protected allowedOrigins(): ReadonlySet<string> {
    return new Set();
  }

  protected refuse(_reason: OriginRefusal, _req: sRequest, res: express.Response, _next: express.NextFunction): void {
    res.status(HTTP_STATUS_CODE.FORBIDDEN).json(REFUSED_BODY);
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    const options: SameOriginOptions = { allowedOrigins: this.allowedOrigins(), missingOrigin: this.MissingOrigin };
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      if (!this.appliesTo(req)) return next();
      const own = req.headers.origin === undefined ? undefined : requestOrigin(req, requestProxyTrust(req));
      const decision = checkSameOrigin(req.headers, own, options);
      if (decision.allowed) return next();
      this.refuse(decision.reason, req, res, next);
    };
  }

  public after(): null {
    return null;
  }
}
