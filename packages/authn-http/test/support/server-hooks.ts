import type { IMiddlewareContext, Response, ServerMiddleware } from '@spinajs/http';

export type MountedHandler = (req: object, res: unknown, next: (err?: unknown) => void) => void;

/**
 * A server middleware's `onBefore` as HttpServer mounts it: null when `isEnabled()` is false; a returned Response is
 * executed and ends the chain, a throw or rejection goes to `next(err)`. Synchronous when the hook is.
 */
export function mounted(m: ServerMiddleware): MountedHandler | null {
  if (!m.isEnabled()) return null;
  return (req, res, next) => {
    const ctx = { req, res, storage: (req as { storage?: unknown }).storage } as IMiddlewareContext;
    const settle = (answer: void | Response) => {
      if (answer) void answer.execute(ctx.req, ctx.res);
      else next();
    };
    let result: void | Response | Promise<void | Response>;
    try {
      result = m.onBefore!(ctx);
    } catch (err) {
      next(err);
      return;
    }
    if (result instanceof Promise) result.then(settle, next).catch(next);
    else settle(result);
  };
}
