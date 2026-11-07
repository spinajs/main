import { performance } from 'node:perf_hooks';
import { RouteMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, IReplyContext, MiddlewareStage } from '../interfaces.js';

const STARTED = Symbol('routeTimingStarted');

/**
 * Adds a `route;dur=<ms>` entry to the `Server-Timing` header: the time from this middleware's onBefore to its onAfter,
 * which covers the route middlewares mounted after it, the argument extraction, the action and the error handlers.
 * Error replies are timed too; a reply the action wrote to `res` itself is not, since onAfter does not run for it.
 *
 * ```ts
 * @Get()
 * @Middleware(RouteTiming)
 * public list() { ... }
 * ```
 */
export class RouteTiming extends RouteMiddleware {
  // outer, so the inner middlewares are inside the measured span
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onBefore({ res }: IMiddlewareContext): Promise<void> {
    (res.locals as Record<symbol, number>)[STARTED] = performance.now();
  }

  public async onAfter({ res, storage }: IReplyContext): Promise<void> {
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED];
    if (started === undefined || res.headersSent) {
      return;
    }

    const dur = Math.round((performance.now() - started) * 100) / 100;
    const entries = storage?.serverTiming;

    // ServerTiming, when enabled, sets the whole header as the response ends and would drop an appended value
    if (entries) {
      entries.push({ name: 'route', dur });
    } else {
      res.append('Server-Timing', `route;dur=${dur}`);
    }
  }
}
