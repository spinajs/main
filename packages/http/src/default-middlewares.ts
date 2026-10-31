import compression from 'compression';
import express from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

import { configuredCookieParser } from './cookie.js';

// A registered symbol, so two copies of the package tag handlers alike.
const SHIPPED = Symbol.for('@spinajs/http.shippedMiddleware');

type ShippedHandler = RequestHandler & { [SHIPPED]?: string };

function shipped(name: string, handler: RequestHandler): RequestHandler {
  (handler as ShippedHandler)[SHIPPED] = name;
  return handler;
}

// Tagged at import: an app that lists this handler alone still has the cookie parser.
shipped('cookie parser', configuredCookieParser);

// ts-node's type check rejects calling the default import that the build accepts.
const securityHeaders = helmet as unknown as (options: { referrerPolicy: { policy: string } }) => RequestHandler;

const EXPECTED = ['helmet', 'JSON body parser', 'form body parser', 'text body parser', 'cookie parser'];

/**
 * The handlers `@spinajs/http` ships as `http.middlewares`. An app's list replaces them, so spread them to keep them:
 * `middlewares: [...defaultMiddlewares(), requestId]`. Each call builds new handlers.
 */
export function defaultMiddlewares(): RequestHandler[] {
  return [
    // helmet's default no-referrer makes browsers send `Origin: null` on same-origin
    // form posts, which authn-http's CSRF guard (A22) refuses.
    shipped('helmet', securityHeaders({ referrerPolicy: { policy: 'strict-origin-when-cross-origin' } })),
    shipped(
      'JSON body parser',
      express.json({
        limit: '5mb',
        // Capture the exact received bytes for the @RawBody() route arg
        // (webhook signature verification needs the unmodified body).
        verify: (req, _res, buf) => {
          (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    ),
    shipped('form body parser', express.urlencoded({ extended: true })),
    // Parse XML request bodies as text so the @FromXml() route arg can read
    // and parse them. Covers application/xml, text/xml and *+xml types.
    shipped('text body parser', express.text({ type: ['application/xml', 'text/xml', 'application/*+xml'], limit: '5mb' })),
    configuredCookieParser,
    compression(),
  ];
}

/** The shipped handlers `list` does not hold. Handlers are plain functions, so an app's own `helmet()` counts as missing. */
export function missingDefaultMiddlewares(list: readonly unknown[]): string[] {
  const held = new Set(list.map((m) => (m as ShippedHandler | undefined)?.[SHIPPED]));
  return EXPECTED.filter((name) => !held.has(name));
}
