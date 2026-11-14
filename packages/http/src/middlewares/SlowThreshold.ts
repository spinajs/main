import { NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, MiddlewareStage } from '../interfaces.js';

function thresholdOf(ms: unknown): number {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) {
    throw new InvalidArgument(`@SlowThreshold needs a non-negative number of milliseconds, got ${String(ms)}`);
  }
  return ms;
}

/** Puts the route's slow-request threshold on `req.storage` for {@link SlowRequestWarning}; mounted by {@link SlowThreshold}. */
@NewInstance()
export class SlowThresholdMiddleware extends RouteMiddleware {
  // outer, so a request an inner middleware refuses is judged by the route's threshold too
  public override readonly Stage: MiddlewareStage = 'outer';

  public readonly thresholdMs: number;

  constructor(thresholdMs: number) {
    super();
    this.thresholdMs = thresholdOf(thresholdMs);
  }

  public onBefore({ storage }: IMiddlewareContext): void {
    storage.slowThresholdMs = this.thresholdMs;
  }
}

/**
 * Replaces `http.slowRequest.thresholdMs` for the route, or on a class for every route of the controller, the route's
 * own declaration winning: `SlowRequestWarning` logs the request when it took `ms` or longer. `Infinity` never warns,
 * for a long poll or a stream. A wrong value fails at import.
 */
export function SlowThreshold(ms: number) {
  return Middleware(SlowThresholdMiddleware, thresholdOf(ms));
}
