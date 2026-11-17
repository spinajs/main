import { Config, effectiveManifestOf } from '@spinajs/configuration';
import { Autoinject, Container, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { RouteIndex } from '@spinajs/http';
import { configuredMountPath, withRoutePrefix } from '@spinajs/manifest';

import { TraceStore } from '../buffers/trace-store.js';
import type { RouteInfo, StudioRoutes } from '../contracts/index.js';
import { joinRoutes, manifestRoutes, routeKey, routeStats, runtimeRoutes, telemetryStats } from './routes.js';

type Latency = Map<string, NonNullable<RouteInfo['stats']>>;

/** The mounted routes and their latency, shared by the routes controller and the access map. */
@Singleton()
@Injectable()
export class RoutesService {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(TraceStore)
  protected Traces: TraceStore;

  @Config('http.controllers.route.prefix')
  protected Prefix: string | undefined;

  @Config('studio.path', { defaultValue: '/_studio' })
  protected Path: string;

  private latencyAt?: { readonly traces: number; readonly routes: number; readonly byRoute: Latency };

  /** What the router serves, Studio's own routes left out; no latency, no manifest. */
  public mounted(): RouteInfo[] {
    const mount = configuredMountPath(this.Path);
    const studioBase = withRoutePrefix(this.Prefix, mount === '/' ? '/' : `/${mount}`);
    return runtimeRoutes(this.index()?.all() ?? [], studioBase);
  }

  public routes(): StudioRoutes {
    const runtime = this.mounted();
    const manifest = effectiveManifestOf(this.Container)?.manifest;
    const data = joinRoutes(runtime, manifest ? manifestRoutes(manifest, this.Prefix) : undefined, this.latency(runtime), telemetryStats(this.Container.get<unknown>('TelemetryStore')));
    return { source: manifest ? 'merged' : 'runtime', data };
  }

  /**
   * One pass over the buffered spans, reused until the trace buffer or the mounted routes change. Only mounted routes are
   * kept, so the cache holds at most one entry per route whatever other server spans the buffer holds.
   */
  protected latency(runtime: readonly RouteInfo[]): Latency {
    const traces = this.Traces.version;
    const routes = this.index()?.version ?? 0;
    const cached = this.latencyAt;
    if (cached && cached.traces === traces && cached.routes === routes) return cached.byRoute;
    const mounted = new Set(runtime.map((r) => routeKey(r.method, r.path)));
    const byRoute: Latency = new Map([...routeStats(this.Traces.spans())].filter(([key]) => mounted.has(key)));
    this.latencyAt = { traces, routes, byRoute };
    return byRoute;
  }

  protected index(): RouteIndex | undefined {
    return this.Container.get(RouteIndex) ?? undefined;
  }
}
