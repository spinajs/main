import { RouteMiddleware } from '@spinajs/http';
import type * as express from 'express';

/** For routes whose answer may hold a link token: no proxy or browser cache may keep one. Set before the route runs, so it goes out with any answer it gives. */
export class NoStore extends RouteMiddleware {
  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
}
