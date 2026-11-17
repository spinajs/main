import { ACCESS_CLASS, accessDescriptorOf } from '@spinajs/authz-http';
import type { IPolicyDescriptor, IRouteMatch } from '@spinajs/http';
import { servedPath, withRoutePrefix } from '@spinajs/manifest';
import type { ControllerEntry, Manifest, PolicyRef, RouteEntry, SourceRef } from '@spinajs/manifest';

import type { RoleGraphLike } from '../authz/roles.js';
import { permId, rolesGraph } from '../authz/roles.js';
import type { GraphNode, RouteInfo, StudioGraph, StudioSpan } from '../contracts/index.js';
import { GraphBuilder } from '../graph/graph.js';
import { truncate } from '../span.js';

type Latency = NonNullable<RouteInfo['stats']>;
type Telemetry = NonNullable<RouteInfo['telemetry']>;
type Guards = Pick<RouteInfo, 'policies' | 'access' | 'controllerPolicies' | 'controllerAccess' | 'allowAnonymous'>;

/** Edges of one access map; past it the map is `truncated`. Routes, permissions and roles are bounded by the app's code and configuration, the edges between them by this. */
export const MAX_ACCESS_MAP_EDGES = 20_000;

export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

// Options of a policy are never sent: they may carry configuration.
const policyName = (p: IPolicyDescriptor): string => truncate(typeof p.Type === 'string' ? p.Type : p.Type.name);
const groups = (g: readonly (readonly IPolicyDescriptor[])[]): string[][] => g.map((group) => group.map(policyName));
const names = (list: readonly string[] | undefined): string[] => (list ?? []).map(truncate);

function unguarded(r: Guards): boolean {
  return r.policies.length === 0 && r.controllerPolicies.length === 0 && r.access.length === 0 && r.controllerAccess.length === 0 && !r.allowAnonymous;
}

function permissionsOf(m: IRouteMatch, key: string | symbol): string[] {
  return names(accessDescriptorOf(m.controller)?.Access.get(key)?.permissions);
}

// `@AllowAnonymous` (authz-http) or `@Public(reason)` (http), on the route or on its class; the reason itself is not sent.
function openOnPurpose(m: IRouteMatch): boolean {
  if (m.route.Public !== undefined || m.controller.Descriptor.Public !== undefined) return true;
  const access = accessDescriptorOf(m.controller);
  return access !== undefined && (access.Anonymous.has(m.route.Method) || access.Anonymous.has(ACCESS_CLASS));
}

function routeInfo(head: Pick<RouteInfo, 'method' | 'path' | 'controller' | 'action'>, guards: Guards): RouteInfo {
  return {
    method: head.method,
    path: truncate(head.path),
    controller: truncate(head.controller),
    action: truncate(head.action),
    policies: guards.policies,
    access: guards.access,
    controllerPolicies: guards.controllerPolicies,
    controllerAccess: guards.controllerAccess,
    allowAnonymous: guards.allowAnonymous,
    unguarded: unguarded(guards),
  };
}

function fromMatch(m: IRouteMatch): RouteInfo {
  return routeInfo(
    {
      // The verb the route answers; `Type` (in `m.path`) may be the `file` flavour of GET, which no span reports.
      method: String(m.route.InternalType).toUpperCase(),
      path: m.path.slice(m.path.indexOf(' ') + 1),
      controller: m.controller.constructor.name,
      action: String(m.route.Method),
    },
    {
      policies: groups(m.route.Policies),
      access: permissionsOf(m, m.route.Method),
      controllerPolicies: groups(m.controller.Descriptor.Policies),
      controllerAccess: permissionsOf(m, ACCESS_CLASS),
      allowAnonymous: openOnPurpose(m),
    },
  );
}

/** What the router actually serves, in router order; Studio's own routes (under `studioBase`) are left out. */
export function runtimeRoutes(matches: readonly IRouteMatch[], studioBase: string): RouteInfo[] {
  return matches.map(fromMatch).filter((r) => r.path !== studioBase && !r.path.startsWith(`${studioBase}/`));
}

const refGroups = (g: readonly (readonly PolicyRef[])[]): string[][] => g.map((group) => group.map((p) => truncate(p.type)));
// http answers a file route on GET.
const manifestMethod = (m: RouteEntry['method']): string => (m === 'file' ? 'GET' : m.toUpperCase());
const sourceOf = (s: SourceRef): SourceRef => ({ file: truncate(s.file), line: s.line, col: s.col, package: truncate(s.package) });

function fromEntry(c: ControllerEntry, r: RouteEntry, prefix: string | undefined): RouteInfo {
  const info = routeInfo(
    { method: manifestMethod(r.method), path: servedPath(withRoutePrefix(prefix, r.fullPath)), controller: c.className, action: r.handler },
    {
      policies: refGroups(r.policies),
      access: names(r.access),
      controllerPolicies: refGroups(c.policies),
      controllerAccess: names(c.access),
      allowAnonymous: r.allowAnonymous === true || c.allowAnonymous === true || r.public !== undefined || c.public !== undefined,
    },
  );
  info.source = sourceOf(r.source);
  return info;
}

export function manifestRoutes(manifest: Manifest, prefix: string | undefined): RouteInfo[] {
  return manifest.controllers.flatMap((c) => c.routes.map((r) => fromEntry(c, r, prefix)));
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

/** Server spans in the trace buffer, keyed like {@link routeKey} on `http.route`, the route template; a span without one (no route matched) is left out. */
export function routeStats(spans: Iterable<StudioSpan>): Map<string, Latency> {
  const samples = new Map<string, { ms: number[]; errors: number }>();
  for (const s of spans) {
    const route = s.attributes['http.route'];
    const method = s.attributes['http.request.method'];
    if (s.kind !== 'server' || typeof route !== 'string' || typeof method !== 'string') continue;
    const key = routeKey(method, route);
    const entry = samples.get(key) ?? { ms: [], errors: 0 };
    entry.ms.push(Number(BigInt(s.durationNs)) / 1e6);
    if (s.status === 'error') entry.errors++;
    samples.set(key, entry);
  }
  const out = new Map<string, Latency>();
  for (const [key, { ms, errors }] of samples) {
    const sorted = ms.sort((a, b) => a - b);
    out.set(key, { count: ms.length, errorRate: round(errors / ms.length), p50Ms: round(percentile(sorted, 50)), p95Ms: round(percentile(sorted, 95)) });
  }
  return out;
}

interface TelemetryRoutesLike {
  RouteStats: { toJSON(): { routes: { method: string; route: string; stats: { responses: number; errors: number } }[] } };
}

// Studio does not depend on @spinajs/telemetry; it reads TelemetryStore by registration name and shape.
function isTelemetryStore(store: unknown): store is TelemetryRoutesLike {
  return typeof store === 'object' && store !== null && 'RouteStats' in store && typeof store.RouteStats === 'object' && store.RouteStats !== null && 'toJSON' in store.RouteStats && typeof store.RouteStats.toJSON === 'function';
}

export function telemetryStats(store: unknown): Map<string, Telemetry> {
  if (!isTelemetryStore(store)) return new Map();
  return new Map(store.RouteStats.toJSON().routes.map((r) => [routeKey(r.method, r.route), { count: r.stats.responses, errorRate: r.stats.responses ? round(r.stats.errors / r.stats.responses) : 0 }]));
}

/**
 * Mounted routes with the manifest source, joined on the served path (a mounted `/users/` is served, and recorded by the
 * manifest, as `/users`), and latency and telemetry, joined on the mounted path the SERVER span and telemetry record.
 */
export function joinRoutes(runtime: readonly RouteInfo[], manifest: readonly RouteInfo[] | undefined, stats: ReadonlyMap<string, Latency>, telemetry: ReadonlyMap<string, Telemetry>): RouteInfo[] {
  const sources = new Map<string, SourceRef>();
  for (const r of manifest ?? []) if (r.source) sources.set(routeKey(r.method, r.path), r.source);
  return runtime.map((r): RouteInfo => {
    const key = routeKey(r.method, r.path);
    const source = sources.get(routeKey(r.method, servedPath(r.path)));
    const s = stats.get(key);
    const t = telemetry.get(key);
    return { ...r, ...(source ? { source } : {}), ...(s ? { stats: s } : {}), ...(t ? { telemetry: t } : {}) };
  });
}

/** Routes, the permissions they require, and the RBAC roles granting one of those; bounded by {@link MAX_ACCESS_MAP_EDGES}. */
export function accessMap(routes: readonly RouteInfo[], roles: RoleGraphLike | undefined): StudioGraph {
  const b = new GraphBuilder();
  const required = new Set<string>();
  let edges = 0;
  const edge = (source: string, target: string, kind: string): boolean => {
    if (edges >= MAX_ACCESS_MAP_EDGES) return false;
    b.edge(source, target, kind);
    edges++;
    return true;
  };
  let truncated = false;
  for (const r of routes) {
    const id = `route:${routeKey(r.method, r.path)}`;
    b.node({ id, label: routeKey(r.method, r.path), kind: 'route', group: r.controller, attributes: { unguarded: r.unguarded, allowAnonymous: r.allowAnonymous, action: r.action } });
    for (const p of [...r.access, ...r.controllerAccess]) {
      if (!edge(id, permId(p), 'requires')) truncated = true;
      else {
        // As the role graph's builder cut it.
        required.add(truncate(permId(p)));
        b.node({ id: permId(p), label: p, kind: 'permission', attributes: {} });
      }
    }
  }
  const rbac = roles ? rolesGraph(roles) : undefined;
  const roleNodes = new Map<string, GraphNode>((rbac?.nodes ?? []).map((n) => [n.id, n]));
  for (const e of rbac?.edges ?? []) {
    if (e.kind !== 'grants' || !required.has(e.target)) continue;
    const role = roleNodes.get(e.source);
    if (!role) continue;
    if (!edge(e.source, e.target, 'grants')) truncated = true;
    else b.node(role);
  }
  return { ...b.build('runtime'), truncated };
}
