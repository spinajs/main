import type { ArgumentModel, ClientModel, ControllerModel, RouteModel } from '../model.js';
import { literal } from '../ts-type.js';

export const DEFAULT_KEY_PREFIX = 'spinajs';

const NO_VARS = 'Record<string, never>';

const REMEDY = 'to generate hooks, or generate client.ts alone without hooks';

export interface HookOptions {
  /** First segment of every query key and cache tag, default `spinajs`. */
  keyPrefix?: string;
}

/** A route that gets a hook: a query (GET) or a mutation (POST, PUT, PATCH, DELETE). */
export interface HookRoute {
  route: RouteModel;
  /** `use<Controller><Handler>`. */
  hookName: string;
  /**
   * One object keyed by argument name, members sorted by name; `Record<string, never>` without arguments, so an optional
   * argument added later keeps every call site compiling.
   */
  varsType: string;
  /** True when callers may leave the variables out: no arguments, or only optional ones. */
  varsOptional: boolean;
  /** The client call, written over the identifiers `client` and `vars`. */
  callExpression: string;
  /** The `appKeys` entry: called on `vars` for a query, the constant itself for a mutation. */
  keyExpression: string;
  tags: { controller: string; route: string };
  /** A paginated query route the client can page through gets an infinite hook as well. */
  infinite?: InfiniteHook;
}

/** The infinite query of a paginated route: its variables leave the page parameter out, and each page call sets it. */
export interface InfiniteHook {
  /** `use<Controller><Handler>Infinite`. */
  hookName: string;
  /** `<handler>Infinite`, the `appKeys` and `appQueries` entry. */
  keyName: string;
  kind: 'offset' | 'cursor';
  /** The first page of an offset route. */
  firstPage: number;
  varsType: string;
  varsOptional: boolean;
  /** The client call over the variables and the page parameter, given as expressions. */
  call(vars: string, page: string): string;
}

interface LabelledHook {
  hook: HookRoute;
  label: string;
}

const capitalize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Sorted, so reordering a handler's parameters changes neither the variables type nor the generated key file.
function varsTypeOf(args: ArgumentModel[]): string {
  if (args.length === 0) return NO_VARS;
  return `{ ${[...args].sort(byName).map((a) => `${a.name}${a.required ? '' : '?'}: ${a.type}`).join('; ')} }`;
}

function keyExpression(route: RouteModel): string {
  const entry = `appKeys.${route.controllerKey}.${route.name}`;
  return route.kind === 'mutation' ? entry : `${entry}(vars)`;
}

function routeLabel(controller: ControllerModel, route: RouteModel): string {
  const entry = controller.entry.routes.find((r) => r.handler === route.name);
  return `${controller.entry.className}.${route.name}${entry ? ` (${entry.method.toUpperCase()} ${entry.fullPath})` : ''}`;
}

function infiniteHook(route: RouteModel, hookName: string): InfiniteHook | undefined {
  const { pagination } = route;
  if (route.kind !== 'query' || !pagination) return undefined;
  const { arg, path } = pagination.param;
  const [property] = path;
  // An undefined property is left out of a JSON query and of a whole query; a cursor of `null` means the first page.
  const value = (page: string) => (pagination.kind === 'cursor' ? `${page} ?? undefined` : page);
  const remaining = route.args.flatMap((a): ArgumentModel[] => {
    if (a.name !== arg) return [a];
    return property === undefined ? [] : [{ ...a, type: `Omit<${a.type}, ${literal(property)}>` }];
  });
  return {
    hookName: `${hookName}Infinite`,
    keyName: `${route.name}Infinite`,
    kind: pagination.kind,
    firstPage: pagination.firstPage ?? 1,
    varsType: varsTypeOf(remaining),
    varsOptional: remaining.every((a) => !a.required),
    call: (vars, page) => {
      const args = route.args.map((a) => {
        if (a.name !== arg) return `${vars}.${a.name}`;
        return property === undefined ? value(page) : `{ ...${vars}.${a.name}, ${property}: ${value(page)} }`;
      });
      return `client.${route.controllerKey}.${route.name}(${args.join(', ')})`;
    },
  };
}

function hookRoute(route: RouteModel, prefix: string): HookRoute {
  const controllerTag = `${prefix}:${route.controllerKey}`;
  const hookName = `use${capitalize(route.controllerKey)}${capitalize(route.name)}`;
  const infinite = infiniteHook(route, hookName);
  return {
    route,
    hookName,
    varsType: varsTypeOf(route.args),
    varsOptional: route.args.every((a) => !a.required),
    callExpression: `client.${route.controllerKey}.${route.name}(${route.args.map((a) => `vars.${a.name}`).join(', ')})`,
    keyExpression: keyExpression(route),
    tags: { controller: controllerTag, route: `${controllerTag}:${route.name}` },
    ...(infinite ? { infinite } : {}),
  };
}

function controllerHooks(controller: ControllerModel, prefix: string): LabelledHook[] {
  if (controller.key === 'all') throw new Error(`generateClientFiles: ${controller.entry.className} (base path '${controller.entry.basePath}') would replace appKeys.all; rename the controller ${REMEDY}`);
  const hooks = controller.routes.filter((r) => r.kind !== 'none').map((r) => ({ hook: hookRoute(r, prefix), label: routeLabel(controller, r) }));
  const clash = hooks.find((h) => h.hook.route.name === 'all');
  if (clash) throw new Error(`generateClientFiles: ${clash.label} would replace appKeys.${controller.key}.all; rename the handler ${REMEDY}`);
  return hooks;
}

// FG-10 and FG-11 export one function per hook name, so a shared name would be a duplicate export.
// An infinite hook takes the name `<hook>Infinite`, which a handler named `<handler>Infinite` would take too.
function refuseSharedNames(hooks: LabelledHook[]): void {
  const seen = new Map<string, string>();
  const names = hooks.flatMap(({ hook, label }) => [[hook.hookName, label], ...(hook.infinite ? [[hook.infinite.hookName, `the infinite query of ${label}`]] : [])]);
  for (const [name, label] of names) {
    const first = seen.get(name);
    if (first !== undefined) throw new Error(`generateClientFiles: ${first} and ${label} would both be ${name}; rename one ${REMEDY}`);
    seen.set(name, label);
  }
}

/** The routes that get hooks, in client order (decision 11: HEAD and file routes get none). */
export function hookRoutes(model: ClientModel, options: HookOptions = {}): HookRoute[] {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const hooks = model.controllers.flatMap((c) => controllerHooks(c, prefix));
  refuseSharedNames(hooks);
  return hooks.map((h) => h.hook);
}

/** The variables parameter of a key factory or hook, defaulted to `{}` when callers may leave it out. */
export function varsParameter(hook: Pick<HookRoute, 'varsType' | 'varsOptional'>): string {
  return hook.varsOptional ? `vars: ${hook.varsType} = {}` : `vars: ${hook.varsType}`;
}

/** The named types the hooks' variables and replies mention, plus `extra`: what a hooks file must import from the client module. Sorted. */
export function typeNames(hooks: HookRoute[], extra: string[] = []): string[] {
  return [...new Set([...hooks.flatMap((h) => [...h.route.args.flatMap((a) => a.typeNames), ...h.route.returnTypeNames]), ...extra])].sort();
}
