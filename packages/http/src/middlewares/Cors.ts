import * as express from 'express';
import { Injectable, Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

const ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/**
 * `value` as a serialized origin (scheme://host[:port]; case, default port and a trailing slash normalised), or
 * undefined when it is anything else.
 */
export function parseOrigin(value: unknown): string | undefined {
  // A value with a path, query, credentials or wildcard host would be cut down to an origin it never named.
  if (typeof value !== 'string' || /[*@\\]/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(value)) return undefined;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

const headerList = (value: unknown): string | undefined => {
  const joined = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return joined === '' ? undefined : joined;
};

/**
 * CORS by rule A31: only listed origins get CORS headers.
 *
 * Config:
 *   http.cors                 absent or falsy: no middleware
 *   http.cors.origins         (string[]) origins as scheme://host[:port], compared exactly as URL origins and
 *                             echoed with credentials and `Vary: Origin`. Empty, null or absent: no CORS headers at
 *                             all, so browsers allow only same-origin requests (2.x reflected every origin here).
 *                             '*' answers `Access-Control-Allow-Origin: *` without credentials to an origin not
 *                             listed explicitly; a listed origin next to '*' still gets its echo with credentials.
 *                             An entry that is not an origin fails the boot.
 *   http.cors.exposedHeaders  (string[]) for allowed origins
 *   http.cors.allowedHeaders  (string[]) for allowed preflights; without it the requested headers are allowed
 *
 * A request from an origin that is not allowed proceeds without CORS headers; the browser then refuses to share
 * the response.
 */
@Injectable(ServerMiddleware)
export class CorsMiddleware extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    // Must run early — preflight needs to short-circuit before any business
    // middleware. Sit just after RequestStorage (-2) and ResponseTime (-1).
    this.Order = -1;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    const cfg = this.Configuration.get<{ origins?: unknown; exposedHeaders?: unknown; allowedHeaders?: unknown } | undefined>('http.cors', undefined);
    const raw = cfg ? (cfg.origins ?? []) : [];
    if (!Array.isArray(raw)) {
      throw new InvalidOption(`http.cors.origins must be a list of origins (scheme://host[:port]) or '*'`);
    }

    const any = raw.includes('*');
    const listed = new Set<string>();
    for (const entry of raw.filter((e) => e !== '*')) {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`http.cors.origins entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port]) or '*'`);
      listed.add(origin);
    }

    if (!any && listed.size === 0) {
      this.Log.warn(`http.cors.origins is not set or empty: no CORS headers are sent, so browsers allow only same-origin requests. List the origins your browser clients use in http.cors.origins.`);
      return null;
    }

    const exposed = headerList(cfg?.exposedHeaders);
    const allowed = headerList(cfg?.allowedHeaders);

    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      if (listed.size > 0) res.vary('Origin');

      const origin = req.headers.origin;
      // Browsers send the serialized origin, the form the listed entries were normalised to.
      const explicit = typeof origin === 'string' && listed.has(origin);
      if (typeof origin !== 'string' || (!explicit && !any)) return next();

      res.setHeader('Access-Control-Allow-Origin', explicit ? origin : '*');
      if (explicit) res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        const requested = req.headers['access-control-request-headers'];
        if (allowed) {
          res.setHeader('Access-Control-Allow-Headers', allowed);
        } else if (requested) {
          res.vary('Access-Control-Request-Headers');
          res.setHeader('Access-Control-Allow-Headers', requested);
        }
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }

      if (exposed) res.setHeader('Access-Control-Expose-Headers', exposed);
      next();
    };
  }

  public after(): null {
    return null;
  }
}
