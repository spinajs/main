import type { ClientModel, ControllerModel, RouteModel } from '../model.js';

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
}

interface LabelledHook {
  hook: HookRoute;
  label: string;
}

const capitalize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Sorted, so reordering a handler's parameters changes neither the variables type nor the generated key file.
function varsType(route: RouteModel): string {
  if (route.args.length === 0) return NO_VARS;
  return `{ ${[...route.args].sort(byName).map((a) => `${a.name}${a.required ? '' : '?'}: ${a.type}`).join('; ')} }`;
}

function keyExpression(route: RouteModel): string {
  const entry = `appKeys.${route.controllerKey}.${route.name}`;
  return route.kind === 'mutation' ? entry : `${entry}(vars)`;
}

function routeLabel(controller: ControllerModel, route: RouteModel): string {
  const entry = controller.entry.routes.find((r) => r.handler === route.name);
  return `${controller.entry.className}.${route.name}${entry ? ` (${entry.method.toUpperCase()} ${entry.fullPath})` : ''}`;
}

function hookRoute(route: RouteModel, prefix: string): HookRoute {
  const controllerTag = `${prefix}:${route.controllerKey}`;
  return {
    route,
    hookName: `use${capitalize(route.controllerKey)}${capitalize(route.name)}`,
    varsType: varsType(route),
    varsOptional: route.args.every((a) => !a.required),
    callExpression: `client.${route.controllerKey}.${route.name}(${route.args.map((a) => `vars.${a.name}`).join(', ')})`,
    keyExpression: keyExpression(route),
    tags: { controller: controllerTag, route: `${controllerTag}:${route.name}` },
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
function refuseSharedNames(hooks: LabelledHook[]): void {
  const seen = new Map<string, string>();
  for (const { hook, label } of hooks) {
    const first = seen.get(hook.hookName);
    if (first !== undefined) throw new Error(`generateClientFiles: ${first} and ${label} would both be ${hook.hookName}; rename one ${REMEDY}`);
    seen.set(hook.hookName, label);
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
export function varsParameter(hook: HookRoute): string {
  return hook.varsOptional ? `vars: ${hook.varsType} = {}` : `vars: ${hook.varsType}`;
}

/** The named types the hooks' variables and replies mention, plus `extra`: what a hooks file must import from the client module. Sorted. */
export function typeNames(hooks: HookRoute[], extra: string[] = []): string[] {
  return [...new Set([...hooks.flatMap((h) => [...h.route.args.flatMap((a) => a.typeNames), ...h.route.returnTypeNames]), ...extra])].sort();
}
