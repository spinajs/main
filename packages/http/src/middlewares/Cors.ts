import * as express from 'express';
import cors from 'cors';
import { Injectable, Container, IContainer, Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

/**
 * CORS middleware extracted verbatim from the previous inline block in
 * `HttpServer.resolve()`. Behavior unchanged — same `http.cors` config keys,
 * same warning when missing, same origin matching. Lives here so it can be
 * tested, replaced, or disabled like any other ServerMiddleware.
 *
 * Config:
 *   http.cors.origins         (string[]; empty/missing allows all)
 *   http.cors.exposedHeaders  (string[])
 *   http.cors.allowedHeaders  (string[])
 */
@Injectable(ServerMiddleware)
export class CorsMiddleware extends ServerMiddleware {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    // Must run early — preflight needs to short-circuit before any business
    // middleware. Sit just after RequestStorage (-2) and ResponseTime (-1).
    this.Order = -1;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    const cOptions = this.Configuration.get<any>('http.cors', undefined);
    if (!cOptions) {
      this.Log.warn(`CORS options not set, server may be unavaible from outside ! Please set http.cors configuration option.`);
      return null;
    }

    const corsOptions = {
      origin(origin: any, callback: any) {
        if (!cOptions || cOptions.origins.length === 0 || cOptions.origins.indexOf(origin) !== -1) {
          callback(null, true);
        } else {
          callback(new Error('cors not allowed'));
        }
      },
      exposedHeaders: cOptions.exposedHeaders,
      allowedHeaders: cOptions.allowedHeaders,
      credentials: true,
    };

    return cors(corsOptions) as any;
  }

  public after(): null {
    return null;
  }
}
