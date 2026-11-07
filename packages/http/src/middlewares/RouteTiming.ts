import type * as express from 'express';
import { performance } from 'node:perf_hooks';
import { Injectable } from '@spinajs/di';
import { RouteMiddleware } from '../interfaces.js';
import type { MiddlewareStage, Request } from '../interfaces.js';

const STARTED = Symbol('routeTimingStarted');

/**
 * Adds a `route;dur=<ms>` entry to the `Server-Timing` header: the time from this middleware's onBefore to its onAfter,
 * which covers the route middlewares mounted after it, the argument extraction and the action. A route that failed
 * gets no entry, because onAfter runs only after a success.
 *
 * ```ts
 * @Get()
 * @Middleware(RouteTiming)
 * public list() { ... }
 * ```
 *
 * Registered as `RouteMiddleware`, so `http.routes.middlewares: ['RouteTiming']` mounts it on every route.
 */
@Injectable(RouteMiddleware)
export class RouteTiming extends RouteMiddleware {
  // outer, so the inner middlewares are inside the measured span
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    (res.locals as Record<symbol, number>)[STARTED] = performance.now();
  }

  public async onAfter(req: express.Request, res: express.Response): Promise<void> {
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED];
    if (started === undefined || res.headersSent) {
      return;
    }

    const dur = Math.round((performance.now() - started) * 100) / 100;
    const entries = (req as Request).storage?.serverTiming;

    // ServerTiming, when enabled, sets the whole header as the response ends and would drop an appended value
    if (entries) {
      entries.push({ name: 'route', dur });
    } else {
      res.append('Server-Timing', `route;dur=${dur}`);
    }
  }
}
