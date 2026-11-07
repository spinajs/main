import type { RequestHandler } from 'express';
import helmet from 'helmet';

// A registered symbol, so two copies of the package tag handlers alike.
const SHIPPED = Symbol.for('@spinajs/http.shippedMiddleware');

type ShippedHandler = RequestHandler & { [SHIPPED]?: string };

function shipped(name: string, handler: RequestHandler): RequestHandler {
  (handler as ShippedHandler)[SHIPPED] = name;
  return handler;
}

// ts-node's type check rejects calling the default import that the build accepts.
const securityHeaders = helmet as unknown as (options: { referrerPolicy: { policy: string } }) => RequestHandler;

const EXPECTED = ['helmet'];

/**
 * The handlers `@spinajs/http` ships as `http.middlewares`: helmet. An app's list replaces them, so spread them to keep
 * them: `middlewares: [...defaultMiddlewares(), yours]`. Each call builds new handlers. The body and cookie parsers are
 * server middlewares configured in `http.bodyParsers`.
 */
export function defaultMiddlewares(): RequestHandler[] {
  return [
    // helmet's default no-referrer makes browsers send `Origin: null` on same-origin
    // form posts, which authn-http's CSRF guard (A22) refuses.
    shipped('helmet', securityHeaders({ referrerPolicy: { policy: 'strict-origin-when-cross-origin' } })),
  ];
}

/** The shipped handlers `list` does not hold. Handlers are plain functions, so an app's own `helmet()` counts as missing. */
export function missingDefaultMiddlewares(list: readonly unknown[]): string[] {
  const held = new Set(list.map((m) => (m as ShippedHandler | undefined)?.[SHIPPED]));
  return EXPECTED.filter((name) => !held.has(name));
}
