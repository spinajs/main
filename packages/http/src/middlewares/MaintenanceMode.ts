import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { HTTP_STATUS_CODE, LifecycleState, ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext, Response } from '../interfaces.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';

export interface IMaintenanceConfiguration {
  enabled?: boolean;
  /** Seconds sent in `Retry-After`. */
  retryAfter?: number;
  /** Path prefixes answered as usual during maintenance, matched on a segment boundary, case-insensitively. */
  allow?: string[];
  message?: string;
}

const MAINTENANCE_MESSAGE = 'The service is down for maintenance, try again later';
const SHUTTING_DOWN_BODY = Object.freeze({ error: Object.freeze({ code: 'shutting_down', message: 'The server is shutting down, try again' }) });

// Express matches routes case-insensitively, so an allowed prefix must too.
const underPath = (path: string, prefix: string): boolean => {
  const p = path.toLowerCase();
  const r = prefix.toLowerCase().replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
};

/** The part of `HttpServer` the lifecycle events carry that this middleware reads. */
interface ILifecycleSource {
  readonly State: LifecycleState;
}

/**
 * Answers 503 instead of the application, at Order -0.5 (after CORS, before everything else):
 *
 * - while `HttpServer` is closing, every request, with `Connection: close`, so a request arriving on a kept-alive
 *   connection during a graceful shutdown is refused and the client reconnects (to another instance);
 * - during maintenance (`http.maintenance.enabled`, or `enable()` at runtime), every request but the `allow`ed path
 *   prefixes, with `Retry-After`.
 *
 * Always mounted, so `isEnabled()` is `true` whatever the configuration says.
 *
 * Config:
 *   http.maintenance.enabled     (default false)
 *   http.maintenance.retryAfter  (seconds, default 60)
 *   http.maintenance.allow       (path prefixes, default [])
 *   http.maintenance.message     (the body's error message)
 */
@Injectable(ServerMiddleware)
export class MaintenanceMode extends ServerMiddleware {
  @Config('http.maintenance')
  protected Maintenance: IMaintenanceConfiguration | undefined;

  @Autoinject(Container)
  protected Container!: IContainer;

  private override?: boolean;
  private server?: ILifecycleSource;

  // the server is not injected: this middleware is resolved while HttpServer resolves
  private readonly track = (server: ILifecycleSource) => {
    this.server = server;
  };

  constructor() {
    super();
    this.Order = -0.5;
  }

  /** Whether requests are answered with the maintenance 503: `enable()`/`disable()`, else `http.maintenance.enabled`. */
  public get Active(): boolean {
    return this.override ?? this.Maintenance?.enabled === true;
  }

  public enable(): void {
    this.override = true;
  }

  public disable(): void {
    this.override = false;
  }

  public async resolve(): Promise<void> {
    this.Container.on('http.server.listening', this.track);
    this.Container.on('http.server.closing', this.track);
    await super.resolve();
  }

  public async dispose(): Promise<void> {
    this.Container.removeListener('http.server.listening', this.track);
    this.Container.removeListener('http.server.closing', this.track);
    this.server = undefined;
    await super.dispose();
  }

  public isEnabled(): boolean {
    return true;
  }

  public onBefore({ req }: IMiddlewareContext): Response | undefined {
    if (this.server?.State === LifecycleState.Closing) {
      return new RawJsonResponse(HTTP_STATUS_CODE.SERVICE_UNAVAILABLE, SHUTTING_DOWN_BODY, { Headers: [{ Name: 'Connection', Value: 'close' }] });
    }

    if (!this.Active) {
      return undefined;
    }

    const cfg = this.Maintenance;
    if (cfg?.allow?.some((prefix) => underPath(req.path, prefix))) {
      return undefined;
    }

    return new RawJsonResponse(
      HTTP_STATUS_CODE.SERVICE_UNAVAILABLE,
      { error: { code: 'maintenance', message: cfg?.message ?? MAINTENANCE_MESSAGE } },
      { Headers: [{ Name: 'Retry-After', Value: String(cfg?.retryAfter ?? 60) }] },
    );
  }
}
