import { AuthzConfigError } from '../../contracts/errors.js';
import { DEFAULT_COMBINE } from '../../engine/routes.js';
import type { CombineConfig, CombineEntry } from '../../engine/routes.js';
import { AUTHZ_DEFAULTS } from './defaults.js';

export interface PermissionConfig {
  readonly description?: string;
  readonly fields?: boolean;
  readonly types?: readonly string[];
  readonly implies?: readonly string[];
}

export interface DomainConfig {
  readonly domain: string;
  readonly parent?: string;
  readonly permissions: Readonly<Record<string, PermissionConfig>>;
  readonly combine: CombineConfig;
  readonly disable: readonly string[];
  readonly engine: { readonly explain: boolean; readonly modelTimeoutMs: number; readonly maxDelegation: number };
  readonly fields: { readonly neverRead: readonly string[]; readonly writeMode: 'strip' | 'reject' };
  readonly cache: { readonly maxEntries: number; readonly ttlSeconds: number };
  readonly audit: { readonly denials: boolean; readonly runAs: boolean; readonly unscoped: boolean; readonly service?: string };
  readonly bus: { readonly service?: string };
  readonly principals: { readonly anonymousEnabled: boolean };
}

/** Reads one configuration value by path segments (segments, not a dotted string: domain names may contain dots). */
export type ConfigGetter = (path: string[]) => unknown;

type Check = (value: unknown) => boolean;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBool: Check = (v) => typeof v === 'boolean';
const isString: Check = (v) => typeof v === 'string';
const isName: Check = (v) => typeof v === 'string' && v.length > 0;
const isInt =
  (min: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min;
const isNonNegative: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStringList: Check = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isWriteMode: Check = (v) => v === 'strip' || v === 'reject';
const isPermissions: Check = (v) => isObject(v) && Object.values(v).every((p) => isObject(p) && (p.description === undefined || isString(p.description)) && (p.fields === undefined || isBool(p.fields)) && (p.types === undefined || isStringList(p.types)) && (p.implies === undefined || isStringList(p.implies)));
const isCombineEntry = (v: unknown): v is CombineEntry => isObject(v) && typeof v.algorithm === 'string' && v.algorithm.length > 0 && (v.models === undefined || isStringList(v.models));
const isCombine: Check = (v) => isObject(v) && isCombineEntry(v.default) && (v.types === undefined || (isObject(v.types) && Object.values(v.types).every(isCombineEntry)));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[k]);
  }
  return value;
}

// Copies plain data so the result never aliases the configuration objects.
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}

export function readDomainConfig(read_: ConfigGetter, lineage: readonly string[]): DomainConfig {
  const domain = lineage[lineage.length - 1] ?? 'root';
  const fail = (key: string, expected: string): never => {
    throw new AuthzConfigError(`Authz domain "${domain}": configuration key ${key} must be ${expected}`);
  };

  // Config prefixes of the levels, root first.
  const levels: string[][] = [['authz'], ...lineage.filter((n) => n !== 'root').map((n) => ['authz', 'domains', n])];
  const pathText = (path: string[]) => path.join('.');

  // One read of the authz tree, then own-property lookups: a domain named 'constructor' must not resolve through the prototype.
  const tree = read_(['authz']);
  const get = (path: string[]): unknown => {
    let cur: unknown = tree;
    for (const seg of path.slice(1)) {
      if (!isObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    }
    return cur;
  };

  const read = (level: string[], key: string, check: Check, expected: string): unknown => {
    const path = [...level, ...key.split('.')];
    const v = get(path);
    if (v === undefined) return undefined;
    if (!check(v)) fail(pathText(path), expected);
    return v;
  };

  const requireObject = (path: string[]): void => {
    const v = get(path);
    if (v !== undefined && !isObject(v)) fail(pathText(path), 'an object');
  };
  requireObject(['authz']);
  requireObject(['authz', 'domains']);
  for (const level of levels) {
    requireObject(level);
    requireObject([...level, 'fields', 'write']);
  }
  requireObject(['authz', 'bus']);
  requireObject(['authz', 'principals']);
  requireObject(['authz', 'principals', 'anonymous']);

  const merged = (name: string, base: object, keys: Record<string, [Check, string]>): Record<string, unknown> => {
    const out = clone(base) as Record<string, unknown>;
    for (const level of levels) {
      const section = get([...level, name]);
      if (section === undefined) continue;
      if (!isObject(section)) fail(pathText([...level, name]), 'an object');
      for (const [key, [check, expected]] of Object.entries(keys)) {
        const v = read([...level, name], key, check, expected);
        if (v !== undefined) out[key] = clone(v);
      }
    }
    return out;
  };

  const engine = merged('engine', AUTHZ_DEFAULTS.engine, {
    explain: [isBool, 'a boolean'],
    modelTimeoutMs: [isInt(1), 'an integer >= 1'],
    maxDelegation: [isInt(0), 'an integer >= 0'],
  }) as unknown as DomainConfig['engine'];

  const cache = merged('cache', AUTHZ_DEFAULTS.cache, {
    maxEntries: [isInt(0), 'an integer >= 0'],
    ttlSeconds: [isNonNegative, 'a number >= 0'],
  }) as unknown as DomainConfig['cache'];

  const audit = merged('audit', AUTHZ_DEFAULTS.audit, {
    denials: [isBool, 'a boolean'],
    runAs: [isBool, 'a boolean'],
    unscoped: [isBool, 'a boolean'],
    service: [isName, 'a non-empty string'],
  }) as unknown as DomainConfig['audit'];

  const fieldsRaw = merged('fields', { neverRead: AUTHZ_DEFAULTS.fields.neverRead, 'write.mode': AUTHZ_DEFAULTS.fields.write.mode }, { neverRead: [isStringList, 'an array of strings'], 'write.mode': [isWriteMode, '"strip" or "reject"'] });
  const fields: DomainConfig['fields'] = { neverRead: fieldsRaw.neverRead as string[], writeMode: fieldsRaw['write.mode'] as 'strip' | 'reject' };

  const root = levels[0];
  const bus: { service?: string } = {};
  const busService = read([...root, 'bus'], 'service', isName, 'a non-empty string');
  if (busService !== undefined) bus.service = busService as string;
  const anonymous = read([...root, 'principals', 'anonymous'], 'enabled', isBool, 'a boolean');
  const principals = { anonymousEnabled: (anonymous as boolean | undefined) ?? AUTHZ_DEFAULTS.principals.anonymous.enabled };

  let combine: CombineConfig = DEFAULT_COMBINE;
  for (let i = levels.length - 1; i >= 0; i--) {
    const v = read(levels[i], 'combine', isCombine, 'an object with default.algorithm (a string) and optional types');
    if (v !== undefined) {
      combine = clone(v) as CombineConfig;
      break;
    }
  }

  const own = levels[levels.length - 1];
  const permissions = (read(own, 'permissions', isPermissions, 'an object of permission definitions') as Record<string, PermissionConfig> | undefined) ?? {};
  const disable = (read(own, 'disable', isStringList, 'an array of strings') as string[] | undefined) ?? [];
  const parent = own === root ? undefined : (read(own, 'parent', isString, 'a string') as string | undefined);

  const result: DomainConfig = {
    domain,
    ...(parent !== undefined ? { parent } : {}),
    permissions: clone(permissions),
    combine,
    disable: clone(disable),
    engine,
    fields,
    cache,
    audit,
    bus,
    principals,
  };
  return deepFreeze(result);
}
