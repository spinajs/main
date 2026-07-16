import * as express from "express";
import { Injectable } from "@spinajs/di";
import { Config } from "@spinajs/configuration";
import { Perf } from "@spinajs/log";

import { ServerMiddleware, Request as sRequest } from "../interfaces.js";

/**
 * Emits one perf rollup per request ( eg. "orm.query x14 240ms" ). Creates the
 * accumulator on `req.storage.perf` in `before()` — which is the SAME object the
 * action's `AsyncLocalStorage.run(req.storage, …)` exposes, so measurements taken
 * during the request land in it — then flushes it to every PerfSink on the
 * response `finish` event.
 *
 * Config:
 *   http.perf.enabled  (default true)
 */
@Injectable(ServerMiddleware)
export class PerfRollup extends ServerMiddleware {
  @Config("http.perf.enabled", { defaultValue: true })
  protected Enabled!: boolean;

  constructor() {
    super();
    // Needs req.storage ( ReqStorage = -2 ); sits alongside AccessLog ( Order 2 ).
    this.Order = 2;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    if (!this.Enabled) return null;
    return (req, res, next) => {
      const startedAt = Date.now();
      req.storage.perf = { requestId: req.storage.requestId, byName: {} };
      res.on("finish", () => {
        Perf.flushScope(req.storage.perf, {
          labels: { method: req.method, route: (req.route as { path?: string })?.path ?? req.originalUrl, status: res.statusCode },
          totalMs: Date.now() - startedAt,
        });
      });
      next();
    };
  }

  public after(): null {
    return null;
  }
}
