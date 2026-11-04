import type { ClientModel, ControllerModel, RouteModel } from '../model.js';

export const DEFAULT_KEY_PREFIX = 'spinajs';

export interface HookOptions {
  /** First segment of every query key and cache tag, default `spinajs`. */
  keyPrefix?: string;
}

/** A route that gets a hook: a query (GET) or a mutation (POST, PUT, PATCH, DELETE). */
export interface HookRoute {
  route: RouteModel;
  /** `use<Controller><Handler>`. */
  hookName: string;
  /** `void` without arguments, else one object keyed by argument name, members sorted by name. */
  varsType: string;
  /** True when callers may leave the variables out: no arguments, or only optional ones. */
  varsOptional: boolean;
  /** The client call, written over the identifiers `client` and `vars`. */
  callExpression: string;
  /** The `appKeys` entry: called on `vars` for a query, the constant itself for a mutation. */
  keyExpression: string;
  tags: { controller: string; route: string };
}

const capitalize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Sorted, so reordering a handler's parameters changes neither the variables type nor the generated key file.
function varsType(route: RouteModel): string {
  if (route.args.length === 0) return 'void';
  return `{ ${[...route.args].sort(byName).map((a) => `${a.name}${a.required ? '' : '?'}: ${a.type}`).join('; ')} }`;
}

function keyExpression(route: RouteModel): string {
  const entry = `appKeys.${route.controllerKey}.${route.name}`;
  if (route.kind === 'mutation') return entry;
  return route.args.length === 0 ? `${entry}()` : `${entry}(vars)`;
}

function refuseKeyClash(controller: ControllerModel): void {
  if (controller.key === 'all') throw new Error(`generateClientFiles: ${controller.entry.className} would replace appKeys.all; rename the controller to generate hooks`);
  if (controller.routes.some((r) => r.name === 'all' && r.kind !== 'none')) {
    throw new Error(`generateClientFiles: ${controller.entry.className}.all would replace appKeys.${controller.key}.all; rename the handler to generate hooks`);
  }
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

/** The routes that get hooks, in client order (decision 11: HEAD and file routes get none). */
export function hookRoutes(model: ClientModel, options: HookOptions = {}): HookRoute[] {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  return model.controllers.flatMap((controller) => {
    refuseKeyClash(controller);
    return controller.routes.filter((r) => r.kind !== 'none').map((r) => hookRoute(r, prefix));
  });
}

/** The variables parameter of a key factory or hook: empty, defaulted to `{}`, or required. */
export function varsParameter(hook: HookRoute): string {
  if (hook.varsType === 'void') return '';
  return hook.varsOptional ? `vars: ${hook.varsType} = {}` : `vars: ${hook.varsType}`;
}
