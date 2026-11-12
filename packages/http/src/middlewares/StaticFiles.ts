import { existsSync } from 'fs';
import Express from 'express';
import type * as express from 'express';
import _ from 'lodash';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import type { IHttpStaticFileConfiguration } from '../interfaces.js';

export const DEFAULT_STATIC_ORDER = 4.5;
export const DEFAULT_STATIC_ROUTE = '/static';

/**
 * Serves the `http.Static` directories, each at its own `Route`, with `express.static` and the entry's `Options`.
 * Mounted at `http.static.order` (default 4.5): after CsrfGuard (4), before authentication (5), so a static request
 * gets CORS, the request id, the access log, throttling and maintenance mode, but no session restore or authz preload.
 * `Infinity` mounts it after every other server middleware, the 3.x placement.
 *
 * A path under a route that is no file falls through to the later middlewares and routing, unless the entry sets
 * `Options.fallthrough: false`: then it is answered with a bare 404 (403 for `dotfiles: 'deny'`), as static files
 * get no framework reply.
 */
@Injectable(ServerMiddleware)
export class StaticFiles extends ServerMiddleware {
  @Config('http.static.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Config('http.static.order', { defaultValue: DEFAULT_STATIC_ORDER })
  protected ConfiguredOrder!: number;

  @Config('http.Static', { defaultValue: [] })
  protected Entries!: IHttpStaticFileConfiguration[];

  @Logger('http')
  protected Log!: Log;

  /** The entries whose directory exists, one per route and directory. */
  protected Served: IHttpStaticFileConfiguration[] = [];

  public async resolve(): Promise<void> {
    // Read here, not in the constructor: @Config reads the container's configuration only once injected.
    this.Order = this.ConfiguredOrder ?? DEFAULT_STATIC_ORDER;

    const entries = _.uniqBy(this.Entries ?? [], (s) => `${s.Route ?? DEFAULT_STATIC_ROUTE}\0${s.Path}`);
    this.Served = entries.filter((s) => {
      if (existsSync(s.Path)) return true;
      this.Log.warn({ path: s.Path }, 'static file path ${path} not exists');
      return false;
    });

    await super.resolve();
  }

  public isEnabled(): boolean {
    return this.Enabled !== false && this.Served.length > 0;
  }

  public handler(): express.RequestHandler {
    const router = Express.Router();
    for (const s of this.Served) {
      const route = s.Route ?? DEFAULT_STATIC_ROUTE;
      this.Log.info({ path: s.Path, route, order: this.Order }, 'Serving static content from: ${path} at path: ${route}, Order ${order}');
      router.use(route, Express.static(s.Path, s.Options));
    }
    // With fallthrough: false, serve-static passes a 404 or 403 on as an error, which the global error answer would
    // turn into a 500. A static file is no framework reply, so its refusal is not one either.
    router.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      const status = (err as { statusCode?: unknown } | null)?.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res.sendStatus(status);
        return;
      }
      next(err);
    });
    return router;
  }
}
