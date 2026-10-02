import { AuthzConfigError } from '../contracts/errors.js';
import type { AuthorizationModel, RoutePlan } from '../contracts/model.js';
import type { Permission, PermissionDef, PermissionRegistry } from '../contracts/permission.js';
import type { ResourceType } from '../contracts/principal.js';

export interface CombineEntry {
  readonly algorithm: string;
  readonly models?: readonly string[];
}

export interface CombineConfig {
  readonly default: CombineEntry;
  readonly types?: Readonly<Record<ResourceType, CombineEntry>>;
}

export const DEFAULT_COMBINE: CombineConfig = Object.freeze({ default: Object.freeze({ algorithm: 'deny-overrides' }) });

export interface RouteTable {
  get(permission: Permission, type: ResourceType): RoutePlan | undefined;
  entries(): readonly { readonly permission: Permission; readonly type: ResourceType; readonly plan: RoutePlan }[];
  readonly unrouted: readonly string[];
}

export interface CompileRoutesInput {
  readonly domain: string;
  readonly models: readonly AuthorizationModel[];
  readonly registry: PermissionRegistry;
  readonly combine: CombineConfig;
  readonly algorithms: readonly string[];
}

const GLOBAL_TYPE: ResourceType = '$global';

interface ResolvedEntry {
  readonly algorithm: string;
  readonly models: readonly AuthorizationModel[];
  readonly explicit: boolean;
}

export function compileRoutes(input: CompileRoutesInput): RouteTable {
  const { domain, models, registry, combine, algorithms } = input;
  const where = `Authz domain ${quote(domain)}`;

  if (!Array.isArray(models)) {
    throw new AuthzConfigError(`${where}: models must be an array`);
  }
  const byName = new Map<string, AuthorizationModel>();
  // Read once: a getter could answer differently on a later read.
  const resourceTypes = new Map<AuthorizationModel, readonly ResourceType[] | '*'>();
  models.forEach((model: AuthorizationModel, index: number) => {
    const { name, allowed } = readModel(model, index, where);
    if (byName.has(name)) {
      throw new AuthzConfigError(`${where}: two models are registered with the name ${quote(name)}`);
    }
    byName.set(name, model);
    resourceTypes.set(model, allowed);
  });
  const allowsType = (model: AuthorizationModel, type: ResourceType): boolean => {
    const allowed = resourceTypes.get(model)!;
    return allowed === '*' || allowed.includes(type);
  };

  if (typeof combine !== 'object' || combine === null) {
    throw new AuthzConfigError(`${where}: combine config must be an object`);
  }
  const resolveEntry = (entry: CombineEntry, label: string): ResolvedEntry => {
    if (typeof entry !== 'object' || entry === null || typeof entry.algorithm !== 'string') {
      throw new AuthzConfigError(`${where}: combine entry for ${label} must be an object with a string algorithm`);
    }
    if (!algorithms.includes(entry.algorithm)) {
      throw new AuthzConfigError(`${where}: combine entry for ${label} names unknown algorithm ${quote(entry.algorithm)} (known: ${algorithms.join(', ')})`);
    }
    if (entry.models === undefined) {
      return { algorithm: entry.algorithm, models, explicit: false };
    }
    if (!Array.isArray(entry.models)) {
      throw new AuthzConfigError(`${where}: combine entry for ${label}: models must be an array of model names`);
    }
    const listed: AuthorizationModel[] = [];
    const seen = new Set<string>();
    for (const name of entry.models as readonly unknown[]) {
      if (typeof name !== 'string') {
        throw new AuthzConfigError(`${where}: combine entry for ${label} lists a non-string model name ${quote(name)}`);
      }
      if (seen.has(name)) {
        throw new AuthzConfigError(`${where}: combine entry for ${label} lists model ${quote(name)} twice`);
      }
      seen.add(name);
      const model = byName.get(name);
      if (!model) {
        throw new AuthzConfigError(`${where}: combine entry for ${label} lists model ${quote(name)}, which is not registered`);
      }
      listed.push(model);
    }
    return { algorithm: entry.algorithm, models: listed, explicit: true };
  };

  const defaultEntry = resolveEntry(combine.default, 'the default');
  const typeEntries = new Map<ResourceType, ResolvedEntry>();
  const combineTypes = combine.types ?? {};
  if (typeof combineTypes !== 'object' || Array.isArray(combineTypes)) {
    throw new AuthzConfigError(`${where}: combine.types must be an object keyed by resource type`);
  }
  for (const type of Object.keys(combineTypes)) {
    typeEntries.set(type, resolveEntry(combineTypes[type], `type ${quote(type)}`));
  }

  const routed = new Map<Permission, Map<ResourceType, RoutePlan>>();
  const entries: { readonly permission: Permission; readonly type: ResourceType; readonly plan: RoutePlan }[] = [];

  for (const def of registry.all()) {
    const byType = new Map<ResourceType, RoutePlan>();
    for (const type of new Set([...def.types, GLOBAL_TYPE])) {
      const entry = typeEntries.get(type) ?? defaultEntry;
      const planModels = entry.models.filter((model) => allowsType(model, type) && applies(model, def, type, where));
      const plan: RoutePlan = Object.freeze({ algorithm: entry.algorithm, models: Object.freeze(planModels) });
      byType.set(type, plan);
      entries.push(Object.freeze({ permission: def.name, type, plan }));
    }
    routed.set(def.name, byType);
  }

  const explicit = [defaultEntry, ...typeEntries.values()].every((e) => e.explicit);
  const listedNames = new Set<string>([defaultEntry, ...typeEntries.values()].flatMap((e) => e.models.map((m) => m.name)));
  const unrouted = explicit ? [...byName.keys()].filter((name) => !listedNames.has(name)) : [];

  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    get: (permission: Permission, type: ResourceType) => routed.get(permission)?.get(type),
    entries: () => frozenEntries,
    unrouted: Object.freeze(unrouted),
  });
}

const readModel = (model: AuthorizationModel, index: number, where: string): { name: string; allowed: readonly ResourceType[] | '*' } => {
  if (typeof model !== 'object' || model === null) {
    throw new AuthzConfigError(`${where}: model at index ${index} is not an object`);
  }
  let name: unknown;
  let capabilities: unknown;
  try {
    name = model.name;
    capabilities = model.capabilities;
  } catch (cause) {
    throw new AuthzConfigError(`${where}: model at index ${index}${typeof name === 'string' ? ` (${quote(name)})` : ''} could not be read`, { cause });
  }
  if (typeof name !== 'string' || name === '') {
    throw new AuthzConfigError(`${where}: model at index ${index} has no string name`);
  }
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new AuthzConfigError(`${where}: model ${quote(name)} has no capabilities object`);
  }
  let allowed: unknown;
  try {
    allowed = (capabilities as { resourceTypes?: unknown }).resourceTypes;
  } catch (cause) {
    throw new AuthzConfigError(`${where}: model ${quote(name)}: capabilities.resourceTypes could not be read`, { cause });
  }
  if (allowed === undefined || allowed === '*') {
    return { name, allowed: '*' };
  }
  if (!Array.isArray(allowed) || !allowed.every((type) => typeof type === 'string' && type !== '')) {
    throw new AuthzConfigError(`${where}: model ${quote(name)}: capabilities.resourceTypes must be absent, '*' or an array of resource types, got ${quote(allowed)}`);
  }
  return { name, allowed: Object.freeze([...allowed]) };
};

const applies = (model: AuthorizationModel, def: PermissionDef, type: ResourceType, where: string): boolean => {
  try {
    return model.applies(def, type) === true;
  } catch (cause) {
    throw new AuthzConfigError(`${where}: model ${quote(model.name)} threw from applies() for permission ${quote(def.name)} on type ${quote(type)}`, { cause });
  }
};

const quote = (value: unknown): string => {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
