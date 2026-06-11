import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import compression from 'compression';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';

/**
 * Gzip/brotli compression of response bodies via the `compression` npm
 * package, wrapped as a ServerMiddleware so it plugs into the standard
 * lifecycle rather than being wired manually in `http.middlewares` config.
 *
 * Config:
 *   http.compression.enabled    (default true)
 *   http.compression.threshold  (default 1024, bytes — bodies below skipped)
 *   http.compression.level      (default -1, zlib default)
 */
@Injectable(ServerMiddleware)
export class Compression extends ServerMiddleware {
  @Config('http.compression.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  @Config('http.compression.threshold', { defaultValue: 1024 })
  protected Threshold!: number;

  @Config('http.compression.level', { defaultValue: -1 })
  protected Level!: number;

  constructor() {
    super();
    // Run early so the response stream is wrapped before controllers write.
    this.Order = 0;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    if (!this.Enabled) return null;
    return compression({ threshold: this.Threshold, level: this.Level }) as any;
  }

  public after(): null {
    return null;
  }
}
