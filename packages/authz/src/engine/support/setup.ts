import { quote } from '@spinajs/util';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { Combinator, NativeFilter } from '../../contracts/model.js';
import type { RelationResolver, ResourceAdapter, ScopeAttributeSchema, ScopeAttributeStore, ScopeResolver } from '../../contracts/adapter.js';
import type { ResourceType } from '../../contracts/principal.js';
import type { DecisionCache } from '../../contracts/service.js';
import type { DecisionTap } from '../../contracts/tap.js';
import { subtractFieldGlobs } from '../../contracts/fields.js';
import { schemaIndex } from '../attributes.js';
import { BUILTIN_COMBINATORS } from '../combinators.js';
import { ENGINE_DEFAULTS } from '../defaults.js';
import { compileRoutes } from '../routes.js';
import type { RouteTable } from '../routes.js';
import { FieldCombiner } from '../fields.js';
import { isObject } from '../internal/util.js';
import type { AuthorizerOptions, Engine, EngineConfig } from '../types.js';
import { declaresPrincipalInArgs } from './misc.js';

export function compileTable(e: Pick<Engine, 'domain' | 'modelList' | 'registry' | 'combineConfig' | 'combinators'>): RouteTable {
  return compileRoutes({ domain: e.domain, models: e.modelList, registry: e.registry, combine: e.combineConfig, algorithms: [...e.combinators.keys()] });
}

/** The built-ins plus the custom combinators, by name. */
export function combinatorsOf(where: string, custom: readonly Combinator[] | undefined): Map<string, Combinator> {
  const combinators = new Map<string, Combinator>();
  for (const c of BUILTIN_COMBINATORS) combinators.set(c.name, c);
  for (const c of custom ?? []) {
    // Duck-typed: a combinator from a second copy of this package (two installed versions) fails instanceof.
    if (!isObject(c) || typeof c.combine !== 'function' || typeof c.name !== 'string' || c.name === '') throw new AuthzConfigError(`${where}: a custom combinator needs a non-empty name and a combine() method`);
    if (combinators.has(c.name)) throw new AuthzConfigError(`${where}: combinator ${quote(c.name)} is ${BUILTIN_COMBINATORS.some((b) => b.name === c.name) ? 'a built-in' : 'registered twice'}`);
    combinators.set(c.name, c);
  }
  return combinators;
}

export function tapsOf(where: string, taps: readonly DecisionTap[] | undefined): readonly DecisionTap[] {
  if (taps === undefined) return Object.freeze([]);
  const list: unknown = taps;
  if (!Array.isArray(list)) throw new AuthzConfigError(`${where}: taps must be an array`);
  // Duck-typed like combinators: a tap from a second copy of this package fails instanceof.
  for (const t of list as readonly unknown[]) if (!isObject(t) || typeof t.onDecision !== 'function') throw new AuthzConfigError(`${where}: a decision tap needs an onDecision() method`);
  return Object.freeze([...taps]);
}

export function decisionCacheOf(where: string, cache: unknown): DecisionCache | undefined {
  // Duck-typed like combinators: a cache from a second copy of this package fails instanceof.
  if (cache !== undefined && (!isObject(cache) || typeof cache.get !== 'function' || typeof cache.set !== 'function' || typeof cache.invalidate !== 'function')) throw new AuthzConfigError(`${where}: cache must be a DecisionCache with get(), set() and invalidate()`);
  return cache as DecisionCache | undefined;
}

type Indexes = Pick<Engine, 'adapterList' | 'adapterByType' | 'resolverByType' | 'relationIndex' | 'natives' | 'argBoundNatives'>;

/** Adapters, scope resolvers, relation resolvers and native filters by key; two for one key is a config error. */
export function resourceIndexes(where: string, options: AuthorizerOptions): Indexes {
  const adapterList = Object.freeze([...(options.adapters ?? [])]);
  const adapterByType = indexAdapters(where, adapterList);
  const resolverByType = indexResolvers(where, options.scopeResolvers ?? []);
  const relationIndex = indexRelations(where, [...(options.relations ?? []), ...adapterList.flatMap((a) => (typeof a.relations === 'function' ? a.relations() : []))]);
  const natives = new Map<string, NativeFilter>();
  const argBoundNatives = new Set<string>();
  for (const filter of options.nativeFilters ?? []) {
    if (natives.has(filter.op)) throw new AuthzConfigError(`${where}: two native filters for op ${quote(filter.op)}`);
    natives.set(filter.op, filter);
    if (declaresPrincipalInArgs(filter)) argBoundNatives.add(filter.op);
  }
  return { adapterList, adapterByType, resolverByType, relationIndex, natives, argBoundNatives };
}

function indexAdapters(where: string, adapters: readonly ResourceAdapter[]): Map<ResourceType, ResourceAdapter> {
  const byType = new Map<ResourceType, ResourceAdapter>();
  for (const adapter of adapters) {
    for (const type of adapter.types) {
      if (byType.has(type)) throw new AuthzConfigError(`${where}: two resource adapters (${quote(byType.get(type)!.kind)}, ${quote(adapter.kind)}) handle type ${quote(type)}`);
      byType.set(type, adapter);
    }
  }
  return byType;
}

function indexResolvers(where: string, resolvers: readonly ScopeResolver[]): Map<ResourceType, ScopeResolver> {
  const byType = new Map<ResourceType, ScopeResolver>();
  for (const resolver of resolvers) {
    for (const type of resolver.types) {
      if (byType.has(type)) throw new AuthzConfigError(`${where}: two scope resolvers handle type ${quote(type)}`);
      byType.set(type, resolver);
    }
  }
  return byType;
}

function indexRelations(where: string, relations: readonly RelationResolver[]): Map<string, RelationResolver> {
  const index = new Map<string, RelationResolver>();
  for (const relation of relations) {
    const key = `${relation.type}\u0000${relation.relation}`;
    if (index.has(key)) throw new AuthzConfigError(`${where}: two relation resolvers for ${quote(relation.relation)} on type ${quote(relation.type)}`);
    index.set(key, relation);
  }
  return index;
}

export function scopeAttributesOf(where: string, options: AuthorizerOptions['scopeAttributes']): Pick<Engine, 'attributeDefaults' | 'attributeStore'> {
  const scopeAttributes: unknown = options === undefined ? {} : options;
  if (!isObject(scopeAttributes)) throw new AuthzConfigError(`${where}: scopeAttributes must be an object`);
  let attributeDefaults: Engine['attributeDefaults'];
  try {
    attributeDefaults = schemaIndex(scopeAttributes.schemas as readonly ScopeAttributeSchema[] | undefined);
  } catch (e) {
    throw e instanceof AuthzConfigError ? new AuthzConfigError(`${where}: ${e.message}`, { cause: e }) : e;
  }
  const store = scopeAttributes.store;
  // Duck-typed like combinators: a store from a second copy of this package fails instanceof.
  if (store !== undefined && (!isObject(store) || typeof store.get !== 'function')) throw new AuthzConfigError(`${where}: scopeAttributes.store must be a ScopeAttributeStore with a get() method`);
  return { attributeDefaults, attributeStore: store as ScopeAttributeStore | undefined };
}

export function fieldSetup(where: string, neverRead: readonly string[]): Pick<Engine, 'fieldCombiner' | 'allFields'> {
  let fieldCombiner: FieldCombiner;
  try {
    fieldCombiner = new FieldCombiner({ neverRead });
  } catch (e) {
    throw e instanceof AuthzConfigError ? new AuthzConfigError(`${where}: config.neverRead: ${e.message}`, { cause: e }) : e;
  }
  const allowed = Object.freeze(subtractFieldGlobs(['*'], neverRead));
  return { fieldCombiner, allFields: Object.freeze({ read: allowed, write: allowed }) };
}

export function readConfig(where: string, c: NonNullable<AuthorizerOptions['config']>): EngineConfig {
  const number = (name: string, v: unknown, dflt: number, min: 'positive' | 'non-negative'): number => {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (min === 'positive' && v === 0)) throw new AuthzConfigError(`${where}: config.${name} must be a ${min} number, got ${quote(v)}`);
    return v;
  };
  const flag = (name: string, v: unknown, dflt: boolean): boolean => {
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') throw new AuthzConfigError(`${where}: config.${name} must be a boolean`);
    return v;
  };
  const neverRead = c.neverRead ?? ENGINE_DEFAULTS.neverRead;
  if (!Array.isArray(neverRead) || neverRead.some((x) => typeof x !== 'string')) throw new AuthzConfigError(`${where}: config.neverRead must be a list of field globs`);
  const maxDelegation = c.maxDelegation ?? ENGINE_DEFAULTS.maxDelegation;
  if (typeof maxDelegation !== 'number' || !Number.isInteger(maxDelegation) || maxDelegation < 0) throw new AuthzConfigError(`${where}: config.maxDelegation must be an integer >= 0`);
  return Object.freeze({
    modelTimeoutMs: number('modelTimeoutMs', c.modelTimeoutMs, ENGINE_DEFAULTS.modelTimeoutMs, 'positive'),
    maxDelegation,
    neverRead: Object.freeze([...neverRead]),
    explain: flag('explain', c.explain, ENGINE_DEFAULTS.explain),
    cacheTtlSeconds: number('cacheTtlSeconds', c.cacheTtlSeconds, ENGINE_DEFAULTS.cacheTtlSeconds, 'non-negative'),
    auditDenials: flag('auditDenials', c.auditDenials, ENGINE_DEFAULTS.auditDenials),
  });
}
