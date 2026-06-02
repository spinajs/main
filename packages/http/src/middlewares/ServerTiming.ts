import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { ServerMiddleware, Request as sRequest, IServerTimingEntry } from '../interfaces.js';

/**
 * Emits a `Server-Timing` response header so browsers / devtools can show
 * internal phase durations alongside the network waterfall.
 *
 * By default it emits a single `total;dur=<ms>` entry. Other code can push
 * additional entries during the request:
 *
 *   req.storage.serverTiming.push({ name: 'db', dur: 12, desc: 'main query' });
 *
 * Header is written by monkey-patching `res.end` so it lands on the response
 * regardless of how the controller flushed — Express ServerMiddleware.after()
 * does not run for normal route responses.
 *
 * Config:
 *   http.serverTiming.enabled  (default true)
 */
@Injectable(ServerMiddleware)
export class ServerTiming extends ServerMiddleware {
  @Config('http.serverTiming.enabled', { defaultValue: true })
  protected Enabled!: boolean;

  constructor() {
    super();
    this.Order = 2;
  }

  public before(): ((req: sRequest, res: express.Response, next: express.NextFunction) => void) | null {
    if (!this.Enabled) return null;
    return (req, res, next) => {
      const startedAt = Date.now();
      req.storage.serverTiming = req.storage.serverTiming ?? [];

      const originalEnd = res.end.bind(res) as typeof res.end;
      (res.end as any) = function patchedEnd(this: express.Response, ...args: any[]) {
        if (!res.headersSent) {
          const entries: IServerTimingEntry[] = req.storage.serverTiming ?? [];
          entries.push({ name: 'total', dur: Date.now() - startedAt });
          res.setHeader('Server-Timing', entries.map(formatEntry).join(', '));
        }
        return originalEnd(...args);
      };

      next();
    };
  }

  public after(): null {
    return null;
  }
}

function formatEntry(e: IServerTimingEntry): string {
  // Per the RFC each metric is "name;dur=<ms>;desc=\"...\"" — quotes are
  // required when the description contains anything but ASCII identifiers.
  const parts = [e.name];
  if (typeof e.dur === 'number') parts.push(`dur=${e.dur}`);
  if (e.desc) parts.push(`desc="${e.desc.replace(/"/g, '\\"')}"`);
  return parts.join(';');
}
