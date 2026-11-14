import express from 'express';
import type { Log } from '@spinajs/log';

import type { ServerMiddleware } from '../../src/interfaces.js';
import type { RouteIndex } from '../../src/route-index.js';
import { lookUpRoutesIn } from '../../src/reply-pipeline.js';
import { serverMiddlewareHandlers } from '../../src/server-middlewares.js';

const noop = () => undefined;
const quiet = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop } as unknown as Log;

/**
 * A bare Express app mounting `middleware` as `HttpServer` does (the request storage first, with the pre-routing
 * lookup in `routes` when given; nothing when `isEnabled()` is false), then `last`.
 */
export function serverApp(middleware: ServerMiddleware, last: express.RequestHandler, routes?: RouteIndex): express.Express {
  const app = express();
  app.use((req, res, next) => {
    (req as unknown as { storage: object }).storage = {};
    if (routes) lookUpRoutesIn(res, routes);
    next();
  });
  if (middleware.isEnabled()) {
    const handlers = serverMiddlewareHandlers(middleware, {
      log: quiet,
      errorReply: () => async (error) => {
        throw error;
      },
    });
    handlers.forEach((h) => app.use(h));
  }
  app.use(last);
  return app;
}
