import type * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, MiddlewareStage } from '../interfaces.js';

const NO_COMPRESSION = Symbol.for('spinajs:http:no-compression');

/** Whether the `Compression` server middleware must leave this response uncompressed. */
export function isCompressionSkipped(res: express.Response): boolean {
  return (res.locals as Record<symbol, unknown>)[NO_COMPRESSION] === true;
}

/**
 * Keeps the `Compression` server middleware off the route's replies, for a body that is already compressed, one a
 * client reads as it streams, or one a BREACH-style length leak must not reach. Mounted by {@link NoCompression}.
 */
@Injectable(RouteMiddleware)
export class NoCompressionMiddleware extends RouteMiddleware {
  // outer, so an answer an inner middleware's onBefore gives is uncompressed too
  public override readonly Stage: MiddlewareStage = 'outer';

  public onBefore({ res }: IMiddlewareContext): void {
    (res.locals as Record<symbol, unknown>)[NO_COMPRESSION] = true;
  }
}

/** Sends the route, or on a class every route of the controller, uncompressed: see {@link NoCompressionMiddleware}. */
export function NoCompression() {
  return Middleware(NoCompressionMiddleware);
}
