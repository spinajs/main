import type * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import compression from 'compression';

import { ServerMiddleware } from '../interfaces.js';

/**
 * Gzip/brotli compression of response bodies via the `compression` npm package, mounted at Order 0 through
 * `handler()`. The only compression the package ships: the default `http.middlewares` hold none.
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

  public isEnabled(): boolean {
    return this.Enabled;
  }

  public handler(): express.RequestHandler {
    return compression({ threshold: this.Threshold, level: this.Level });
  }
}
