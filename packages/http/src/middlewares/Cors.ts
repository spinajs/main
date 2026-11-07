import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { FIELD_NAME_PATTERN } from '../headers.js';
import { HTTP_STATUS_CODE, Response, ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext } from '../interfaces.js';

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

// A page on a listed origin that could send these would choose what the app believes a trusted proxy said:
// the client address and the app's own origin (authn-http's CSRF guard compares Origin with it).
const PROXY_HEADER = /^(forwarded|x-forwarded-[a-z0-9-]*)$/i;

const withoutProxyHeaders = (list: string | undefined, keep: (name: string) => boolean = () => true): string | undefined => {
  const kept = (list ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '' && !PROXY_HEADER.test(h) && keep(h))
    .join(',');
  return kept === '' ? undefined : kept;
};

// RFC 9110 field-name: anything else in Access-Control-Request-Headers names no header and is not echoed back.
const isFieldName = (name: string): boolean => FIELD_NAME_PATTERN.test(name);

/** What a request's Origin gets: `Access-Control-Allow-Origin: <allowOrigin>`, and credentials when `credentials`. */
export interface CorsAllowance {
  readonly allowOrigin: string;
  readonly credentials: boolean;
}

interface ICorsPolicy {
  readonly any: boolean;
  readonly listed: ReadonlySet<string>;
  readonly exposed?: string;
  readonly allowed?: string;
}

/** The answer to an allowed preflight: 204 without a body, with the CORS headers already set on `res`. */
class PreflightResponse extends Response<null> {
  protected _errorCode = HTTP_STATUS_CODE.NO_CONTENT;
  protected _template = '';

  constructor() {
    super(null);
  }

  public execute(_req: express.Request, res: express.Response): Promise<void> {
    res.statusCode = this.statusCode;
    for (const header of this.headers) {
      res.setHeader(header.Name, header.Value);
    }
    res.setHeader('Content-Length', '0');
    res.end();
    return Promise.resolve();
  }
}

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
 *   http.cors.allowedHeaders  (string[]) for allowed preflights; without it the requested headers are allowed.
 *                             `Forwarded` and `X-Forwarded-*` are never allowed.
 *
 * A request from an origin that is not allowed proceeds without CORS headers; the browser then refuses to share
 * the response. An allowed preflight is answered 204 here, through the reply pipeline.
 */
@Injectable(ServerMiddleware)
export class CorsMiddleware extends ServerMiddleware {
  @Config('http.cors')
  protected Cors: { origins?: readonly string[] | null; exposedHeaders?: unknown; allowedHeaders?: unknown } | boolean | null | undefined;

  @Logger('http')
  protected Log!: Log;

  private policy?: ICorsPolicy | null;

  constructor() {
    super();
    // early, so a preflight is answered before any business middleware runs
    this.Order = -1;
  }

  public async resolve(): Promise<void> {
    this.corsPolicy();
    await super.resolve();
  }

  /** Off without origins in `http.cors.origins`. */
  public isEnabled(): boolean {
    return this.corsPolicy() !== null;
  }

  /**
   * What `origin` (the request's Origin header, as sent) gets, or undefined for no CORS headers. By default a listed
   * origin is echoed with credentials, and any other gets '*' when `http.cors.origins` holds '*'. Override it to allow
   * origins by a rule.
   */
  protected allowance(origin: string): CorsAllowance | undefined {
    const policy = this.corsPolicy();
    // Browsers send the serialized origin, the form the listed entries were normalised to.
    if (policy?.listed.has(origin)) return { allowOrigin: origin, credentials: true };
    return policy?.any ? { allowOrigin: '*', credentials: false } : undefined;
  }

  public onBefore({ req, res }: IMiddlewareContext): Response | undefined {
    const policy = this.corsPolicy();
    if (!policy) return undefined;
    if (policy.listed.size > 0) res.vary('Origin');

    const origin = req.headers.origin;
    const allowance = typeof origin === 'string' ? this.allowance(origin) : undefined;
    if (!allowance) return undefined;

    res.setHeader('Access-Control-Allow-Origin', allowance.allowOrigin);
    if (allowance.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      const requested = req.headers['access-control-request-headers'];
      if (policy.allowed) {
        res.setHeader('Access-Control-Allow-Headers', policy.allowed);
      } else if (requested) {
        res.vary('Access-Control-Request-Headers');
        const echoed = withoutProxyHeaders(requested, isFieldName);
        if (echoed) res.setHeader('Access-Control-Allow-Headers', echoed);
      }
      return new PreflightResponse();
    }

    if (policy.exposed) res.setHeader('Access-Control-Expose-Headers', policy.exposed);
    return undefined;
  }

  private corsPolicy(): ICorsPolicy | null {
    if (this.policy !== undefined) return this.policy;

    // true passes the schema (no CORS, as false does) and has no origins to read.
    const cfg = typeof this.Cors === 'object' ? this.Cors : null;
    const raw = cfg?.origins ?? [];

    const any = raw.includes('*');
    const listed = new Set<string>();
    for (const entry of raw.filter((e) => e !== '*')) {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`http.cors.origins entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port]) or '*'`);
      listed.add(origin);
    }

    if (!any && listed.size === 0) {
      this.Log.warn(`http.cors.origins is not set or empty: no CORS headers are sent, so browsers allow only same-origin requests. List the origins your browser clients use in http.cors.origins.`);
      this.policy = null;
    } else {
      this.policy = { any, listed, exposed: headerList(cfg?.exposedHeaders), allowed: withoutProxyHeaders(headerList(cfg?.allowedHeaders)) };
    }
    return this.policy;
  }
}
