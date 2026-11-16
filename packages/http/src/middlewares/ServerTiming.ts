import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { ServerMiddleware, IServerTimingEntry } from '../interfaces.js';
import type { IMiddlewareContext, IReplyContext } from '../interfaces.js';

const STARTED = Symbol('serverTimingStarted');

/**
 * Emits a `Server-Timing` response header so browsers / devtools can show
 * internal phase durations alongside the network waterfall.
 *
 * By default it emits a single `total;dur=<ms>` entry. Other code can push
 * additional entries during the request:
 *
 *   req.storage.serverTiming.push({ name: 'db', dur: 12, desc: 'main query' });
 *
 * The header is set in onAfter, after the route middlewares' onAfter (RouteTiming's `route` entry), so static files
 * and replies an action writes to `res` itself get none.
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

  public isEnabled(): boolean {
    return this.Enabled;
  }

  public onBefore({ res, storage }: IMiddlewareContext): void {
    (res.locals as Record<symbol, number>)[STARTED] = Date.now();
    storage.serverTiming = storage.serverTiming ?? [];
  }

  public onAfter({ res, storage }: IReplyContext): void {
    const started = (res.locals as Record<symbol, number | undefined>)[STARTED];
    if (started === undefined) {
      return;
    }
    const entries: IServerTimingEntry[] = storage.serverTiming ?? [];
    entries.push({ name: 'total', dur: Date.now() - started });
    res.setHeader('Server-Timing', entries.map(formatEntry).join(', '));
  }
}

function formatEntry(e: IServerTimingEntry): string {
  // Per the RFC each metric is "name;dur=<ms>;desc=\"...\"" — quotes are
  // required when the description contains anything but ASCII identifiers.
  const parts = [e.name];
  if (typeof e.dur === 'number') parts.push(`dur=${e.dur}`);
  if (e.desc) parts.push(`desc="${e.desc.replace(/[\\"]/g, '\\$&')}"`);
  return parts.join(';');
}
