import { configuredMountPath, controllerMountPath, routeFullPath, servedPath } from './route-path.js';
import type { ControllerEntry, ParamEntry, PolicyRef, RouteEntry, SocketControllerEntry, SourceRef } from './types.js';

const ACCESS_POLICY = 'AccessPolicy';
const FIELDS_MIDDLEWARE = 'AuthzFieldsMiddleware';

/** What a subclass declares on a method it redeclares; `route` is set when the method carries a verb decorator. */
export interface RouteOverride {
  handler: string;
  route?: RouteEntry;
  /** The redeclared method's decorated params, also when `route` is set (`route.params` is not read). Merged by index. */
  params: ParamEntry[];
  policies: PolicyRef[][];
  middlewares: RouteEntry['middlewares'];
  access?: string[];
  allowAnonymous?: boolean;
  public?: string;
  doc?: RouteEntry['doc'];
  source: SourceRef;
}

const isAccessGroup = (group: PolicyRef[]): boolean => group[0]?.type === ACCESS_POLICY;

// `@Access` splices the inherited access group out before it pushes its own (authz-http access/decorators.ts).
export function inheritPolicies(inherited: PolicyRef[][], own: PolicyRef[][]): PolicyRef[][] {
  const kept = own.some(isAccessGroup) ? inherited.filter((g) => !isAccessGroup(g)) : inherited;
  return [...kept, ...own];
}

export function inheritMiddlewares(inherited: RouteEntry['middlewares'], own: RouteEntry['middlewares']): RouteEntry['middlewares'] {
  const merged = [...inherited, ...own];
  const firstFields = merged.findIndex((m) => m.type === FIELDS_MIDDLEWARE);
  return merged.filter((m, i) => m.type !== FIELDS_MIDDLEWARE || i === firstFields);
}

const mountPathOf = (basePath: string | null, basePathConfig: string | undefined, className: string): string =>
  basePathConfig && basePath ? configuredMountPath(basePath) : controllerMountPath(basePath, className);

// `Parameter()` decorating an index again patches its kind, options and schemas but keeps the base's `RuntimeType`.
function redecorated(base: ParamEntry, own: ParamEntry): ParamEntry {
  const { ref: _ownRef, refProblem: _ownProblem, ...contract } = own.runtimeType;
  const { ref, refProblem } = base.runtimeType;
  return { ...own, runtimeType: { ...contract, ...(ref ? { ref } : {}), ...(refProblem !== undefined ? { refProblem } : {}) } };
}

function mergeParams(inherited: ParamEntry[], own: ParamEntry[]): ParamEntry[] {
  const byIndex = new Map(inherited.map((p) => [p.index, p]));
  for (const p of own) {
    const base = byIndex.get(p.index);
    byIndex.set(p.index, base ? redecorated(base, p) : p);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function overriddenRoute(inherited: RouteEntry, override: RouteOverride): RouteEntry {
  const declared = override.route;
  const access = override.access ?? inherited.access;
  const reason = override.public ?? inherited.public;
  const doc = override.doc ?? inherited.doc;
  const { pagination: inheritedPagination, ...rest } = inherited;
  // Follows `returnType`: a redeclared verb route that returns no page is not paginated.
  const pagination = declared ? declared.pagination : inheritedPagination;
  return {
    ...rest,
    method: declared?.method ?? inherited.method,
    path: declared?.path ?? inherited.path,
    params: mergeParams(inherited.params, override.params),
    returnType: declared?.returnType ?? inherited.returnType,
    ...(pagination ? { pagination } : {}),
    policies: inheritPolicies(inherited.policies, override.policies),
    middlewares: inheritMiddlewares(inherited.middlewares, override.middlewares),
    ...(access ? { access } : {}),
    ...(override.allowAnonymous || inherited.allowAnonymous ? { allowAnonymous: true } : {}),
    ...(reason !== undefined ? { public: reason } : {}),
    ...(doc ? { doc } : {}),
    source: override.source,
  };
}

/**
 * `own` with everything `ancestor` (already effective for its own chain) contributes, as the runtime collapses the
 * controller descriptor: inherited routes first and in their order, a redeclared one in its inherited place.
 */
export function inheritController(ancestor: ControllerEntry, own: ControllerEntry, overrides: readonly RouteOverride[]): ControllerEntry {
  const declaresPath = own.basePath !== null;
  const basePath = declaresPath ? own.basePath : ancestor.basePath;
  const basePathConfig = declaresPath ? own.basePathConfig : ancestor.basePathConfig;
  const mountPath = mountPathOf(basePath, basePathConfig, own.className);
  const at = (r: RouteEntry): RouteEntry => ({ ...r, fullPath: servedPath(routeFullPath(mountPath, r.path, r.handler)) });

  const overrideOf = new Map(overrides.map((o) => [o.handler, o]));
  const inherited = ancestor.routes.map((r) => {
    const override = overrideOf.get(r.handler);
    return at({ ...(override ? overriddenRoute(r, override) : r), inheritedFrom: r.inheritedFrom ?? ancestor.id });
  });
  const inheritedHandlers = new Set(ancestor.routes.map((r) => r.handler));
  const access = own.access ?? ancestor.access;
  const reason = own.public ?? ancestor.public;

  return {
    ...own,
    basePath,
    ...(basePathConfig ? { basePathConfig } : {}),
    mountPath,
    policies: inheritPolicies(ancestor.policies, own.policies),
    middlewares: inheritMiddlewares(ancestor.middlewares, own.middlewares),
    ...(access ? { access } : {}),
    ...(own.allowAnonymous || ancestor.allowAnonymous ? { allowAnonymous: true } : {}),
    ...(reason !== undefined ? { public: reason } : {}),
    routes: [...inherited, ...own.routes.filter((r) => !inheritedHandlers.has(r.handler)).map(at)],
    bases: [ancestor.id, ...(ancestor.bases ?? [])],
  };
}

/** The runtime merge of `@spinajs/http-socket`, shared so the compiler records exactly what a boot resolves. */
export function inheritSocketHandlers(entry: SocketControllerEntry, bases: readonly SocketControllerEntry[]): SocketControllerEntry {
  const commands = [...entry.commands];
  const events = [...entry.events];
  const diArgs = [...(entry.diArgs ?? [])];
  let contract = entry.contract;

  for (const base of bases) {
    commands.push(...base.commands.filter((c) => !commands.some((own) => own.handler === c.handler)).map((c) => ({ ...c, inheritedFrom: c.inheritedFrom ?? base.id })));
    events.push(...base.events.filter((e) => !events.some((own) => own.name === e.name)).map((e) => ({ ...e, inheritedFrom: e.inheritedFrom ?? base.id })));
    diArgs.push(...(base.diArgs ?? []).filter((a) => !diArgs.some((own) => own.handler === a.handler)));
    contract ??= base.contract;
  }
  return { ...entry, commands, events, ...(diArgs.length ? { diArgs } : {}), ...(contract ? { contract } : {}) };
}
