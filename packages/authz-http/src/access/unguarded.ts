import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

/** `authz.http.unguardedRoutes`: what to do about a route with no `@Access`, `@Policy` or `@AllowAnonymous` on it or its class. */
export type UnguardedRoutesMode = 'warn' | 'throw' | 'off';

/** `Controller.method` of every http route of `controllers` that nothing guards. */
export function findUnguardedRoutes(_controllers: Iterable<object>): string[] {
  throw new Error('not implemented: findUnguardedRoutes');
}

@Injectable()
export class UnguardedRoutesReport {
  @Logger('authz-http')
  protected Log: Log;

  @Config('authz.http.unguardedRoutes', { defaultValue: 'warn' })
  protected Mode: UnguardedRoutesMode;

  /** Checks `controllers` (the registered http controllers when omitted); returns the unguarded routes. */
  public run(_controllers?: Iterable<object>): string[] {
    throw new Error('not implemented: UnguardedRoutesReport.run');
  }
}
