import { deepFreeze, isPlainObject } from '@spinajs/util';
import { DEFAULT_COMBINE } from '../../engine/routes.js';
import type { CombineConfig } from '../../engine/routes.js';
import { ROOT_DOMAIN } from '../../contracts/service.js';
import { AUTHZ_DEFAULTS } from './defaults.js';

export interface PermissionConfig {
  readonly description?: string;
  readonly fields?: boolean;
  readonly list?: boolean;
  readonly consistency?: 'cached' | 'fresh';
  readonly types?: readonly string[];
  readonly implies?: readonly string[];
}

export interface DomainConfig {
  readonly domain: string;
  readonly parent?: string;
  readonly permissions: Readonly<Record<string, PermissionConfig>>;
  readonly combine: CombineConfig;
  readonly disable: readonly string[];
  /** The models this level activates, by registered name; undefined: the level activates what its container registers under AuthorizationModel. */
  readonly use?: readonly string[];
  readonly engine: { readonly explain: boolean; readonly modelTimeoutMs: number; readonly maxDelegation: number };
  readonly fields: { readonly neverRead: readonly string[]; readonly writeMode: 'strip' | 'reject' };
  readonly cache: { readonly maxEntries: number; readonly ttlSeconds: number };
  readonly audit: { readonly denials: boolean; readonly runAs: boolean; readonly unscoped: boolean; readonly service?: string };
  readonly bus: { readonly service?: string };
  readonly principals: { readonly anonymousEnabled: boolean };
}

/** The value at `path` in `tree`, by own properties only: a domain named 'constructor' must not resolve through the prototype. */
export function configAt(tree: unknown, path: readonly string[]): unknown {
  let cur = tree;
  for (const seg of path) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Copies plain data so the result never aliases the configuration objects.
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}

/**
 * The configuration of the last domain of `lineage` (root first) in the `authz` tree. The schema has checked every
 * level, so this only merges: a key comes from the nearest level that sets it, over AUTHZ_DEFAULTS.
 */
export function readDomainConfig(tree: unknown, lineage: readonly string[]): DomainConfig {
  const domain = lineage[lineage.length - 1] ?? ROOT_DOMAIN;
  const levels = [tree, ...lineage.filter((n) => n !== ROOT_DOMAIN).map((n) => configAt(tree, ['domains', n]))];
  const own = levels[levels.length - 1];

  const merged = (path: readonly string[], base: object, keys: readonly string[]): Record<string, unknown> => {
    const out = clone({ ...base }) as Record<string, unknown>;
    for (const level of levels) {
      for (const key of keys) {
        const v = configAt(level, [...path, key]);
        if (v !== undefined) out[key] = clone(v);
      }
    }
    return out;
  };

  const engine = merged(['engine'], AUTHZ_DEFAULTS.engine, ['explain', 'modelTimeoutMs', 'maxDelegation']) as unknown as DomainConfig['engine'];
  const cache = merged(['cache'], AUTHZ_DEFAULTS.cache, ['maxEntries', 'ttlSeconds']) as unknown as DomainConfig['cache'];
  const audit = merged(['audit'], AUTHZ_DEFAULTS.audit, ['denials', 'runAs', 'unscoped', 'service']) as unknown as DomainConfig['audit'];
  const fields: DomainConfig['fields'] = {
    neverRead: merged(['fields'], { neverRead: AUTHZ_DEFAULTS.fields.neverRead }, ['neverRead']).neverRead as string[],
    writeMode: merged(['fields', 'write'], AUTHZ_DEFAULTS.fields.write, ['mode']).mode as 'strip' | 'reject',
  };

  // combine is taken whole from the nearest level, never merged key by key.
  const nearest = [...levels].reverse().find((level) => configAt(level, ['combine']) !== undefined);
  const combine = nearest === undefined ? DEFAULT_COMBINE : (clone(configAt(nearest, ['combine'])) as CombineConfig);

  const busService = configAt(tree, ['bus', 'service']) as string | undefined;
  const anonymous = configAt(tree, ['principals', 'anonymous', 'enabled']) as boolean | undefined;
  const parent = levels.length > 1 ? (configAt(own, ['parent']) as string | undefined) : undefined;
  const use = configAt(own, ['use']) as string[] | undefined;

  const result: DomainConfig = {
    domain,
    ...(parent !== undefined ? { parent } : {}),
    ...(use !== undefined ? { use: clone(use) } : {}),
    permissions: clone((configAt(own, ['permissions']) ?? {}) as Record<string, PermissionConfig>),
    combine,
    disable: clone((configAt(own, ['disable']) ?? []) as string[]),
    engine,
    fields,
    cache,
    audit,
    bus: busService === undefined ? {} : { service: busService },
    principals: { anonymousEnabled: anonymous ?? AUTHZ_DEFAULTS.principals.anonymous.enabled },
  };
  return deepFreeze(result);
}
