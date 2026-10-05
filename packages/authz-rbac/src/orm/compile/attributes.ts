import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType, ScopeAttributeSchema } from '@spinajs/authz';

import type { RbacSqlDialect } from './dialect.js';
import type { RbacPathSql } from './path.js';
import { FALSE_SQL, TRUE_SQL, andSql, ident, intSql, joinSql, notSql, orSql, rsql } from './sql.js';
import type { RbacSql } from './sql.js';

export const SCOPE_ATTRIBUTE_TABLE = 'authz_scope_attribute';
const SA = 'authz_sa';

/** A schema default at one path: a scalar (its JSON text), null, a nested object or a list. */
export type RbacDefaultEntry = { readonly kind: 'scalar'; readonly json: string } | { readonly kind: 'null' } | { readonly kind: 'object' } | { readonly kind: 'list' };

// The engine's mergeAttributes limits (engine/attributes.ts).
const MAX_DEPTH = 32;
const MAX_VALUES = 10_000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BAD = Symbol('bad');

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Where the engine's attributes of a scope type come from besides the schema defaults and the store
 * (`authorizer.loadAttributes`: defaults ⊕ the adapter's `scopeAttributes`, else the resolver's `attributes`,
 * ⊕ the store).
 * - `store`: neither an adapter's `scopeAttributes` nor a resolver's `attributes` serves the type, so the
 *   engine reads defaults ⊕ store, as the SQL does.
 * - `adapter`: an adapter (or resolver) layer serves it with the top-level keys `attributes`. A read under one
 *   of them is a fault here (the SQL cannot read that layer; narrower). Any other read needs `exists`, TRUE for a
 *   node whose row the adapter finds (it answers null for a missing row and the engine faults); without
 *   `exists` every read is a fault.
 * `ormRbacScopeLayers` gives the layers of the types authz-orm's adapter serves; callers declare the others.
 * An undeclared type reads as a fault. GLOBAL is `store` unless declared.
 */
export type RbacScopeLayer = { readonly kind: 'store' } | { readonly kind: 'adapter'; readonly attributes: readonly string[]; readonly exists?: (nodeId: RbacSql) => RbacSql };

/**
 * The schema defaults of each scope type as constants, read as the engine's `schemaIndex` merges them
 * (`mergeAttributes` of one layer): unsafe keys and values it cannot represent are dropped, Dates become ISO
 * strings, a list with a bad element is dropped whole. Keys holding '.' are left out: no attribute path
 * reaches them. With them, the attribute layer of each scope type (`RbacScopeLayer`).
 */
export class RbacScopeDefaults {
  private constructor(private readonly byType: ReadonlyMap<ResourceType, ReadonlyMap<string, RbacDefaultEntry>>, private readonly layers: ReadonlyMap<ResourceType, RbacScopeLayer>) {}

  static of(schemas: readonly ScopeAttributeSchema[] | undefined, layers: Readonly<Record<ResourceType, RbacScopeLayer>> = {}): RbacScopeDefaults {
    const byType = new Map<ResourceType, ReadonlyMap<string, RbacDefaultEntry>>();
    const layerMap = new Map<ResourceType, RbacScopeLayer>([[GLOBAL.type, { kind: 'store' }]]);
    for (const [type, layer] of Object.entries(layers ?? {})) {
      if (layer?.kind === 'store') layerMap.set(type, { kind: 'store' });
      else if (layer?.kind === 'adapter' && Array.isArray(layer.attributes) && layer.attributes.every((a) => typeof a === 'string' && a !== '') && (layer.exists === undefined || typeof layer.exists === 'function')) {
        layerMap.set(type, { kind: 'adapter', attributes: [...layer.attributes], ...(layer.exists ? { exists: layer.exists } : {}) });
      } else throw new AuthzConfigError(`the attribute layer of scope type '${type}' must be { kind: 'store' } or { kind: 'adapter', attributes: [names], exists? }`);
    }
    if (schemas === undefined) return new RbacScopeDefaults(byType, layerMap);
    if (!Array.isArray(schemas)) throw new AuthzConfigError('scope attribute schemas must be a list');
    for (const schema of schemas) {
      if (schema === null || typeof schema !== 'object') throw new AuthzConfigError('a scope attribute schema must be an object');
      const { scopeType, defaults } = schema;
      if (typeof scopeType !== 'string' || scopeType === '') throw new AuthzConfigError('a scope attribute schema must name its scopeType');
      if (byType.has(scopeType)) throw new AuthzConfigError(`two scope attribute schemas for type '${scopeType}'`);
      if (!isPlainObject(defaults)) throw new AuthzConfigError(`the defaults of the scope attribute schema for '${scopeType}' must be a plain object`);
      const entries = new Map<string, RbacDefaultEntry>();
      flattenDefaults(defaults, '', 1, { seen: new Set(), left: MAX_VALUES, type: scopeType }, entries, true);
      byType.set(scopeType, entries);
    }
    return new RbacScopeDefaults(byType, layerMap);
  }

  /** Undefined: undeclared, every read is a fault. */
  layer(type: ResourceType): RbacScopeLayer | undefined {
    return this.layers.get(type);
  }

  /** Every path with a default for `type`, nested objects and lists included. */
  entries(type: ResourceType): ReadonlyMap<string, RbacDefaultEntry> {
    return this.byType.get(type) ?? new Map();
  }

  /** The default at `path`, or undefined when there is none: also below a scalar, a null or a list (the SQL reads no list elements). */
  lookup(type: ResourceType, path: string): RbacDefaultEntry | undefined {
    return this.byType.get(type)?.get(path);
  }
}

interface Walk {
  readonly seen: Set<object>;
  left: number;
  readonly type: string;
}

function enter(v: object, depth: number, walk: Walk): void {
  if (depth > MAX_DEPTH) throw new AuthzConfigError(`the defaults of the scope attribute schema for '${walk.type}' are nested deeper than ${MAX_DEPTH}`);
  if (walk.seen.has(v)) throw new AuthzConfigError(`the defaults of the scope attribute schema for '${walk.type}' hold a cycle`);
  walk.seen.add(v);
}

function spend(walk: Walk, n: number): void {
  if (n > walk.left) throw new AuthzConfigError(`the defaults of the scope attribute schema for '${walk.type}' hold more than ${MAX_VALUES} values`);
  walk.left -= n;
}

/** Adds the entries of a plain object at `prefix`; `reachable` is false below a key holding '.'. */
function flattenDefaults(obj: Record<string, unknown>, prefix: string, depth: number, walk: Walk, out: Map<string, RbacDefaultEntry>, reachable: boolean): void {
  enter(obj, depth, walk);
  try {
    const keys = Object.keys(obj);
    spend(walk, keys.length);
    for (const k of keys) {
      if (UNSAFE_KEYS.has(k)) continue;
      const v = obj[k];
      if (v === undefined) continue;
      const path = prefix === '' ? k : `${prefix}.${k}`;
      const here = reachable && !k.includes('.');
      if (isPlainObject(v)) {
        if (here) out.set(path, { kind: 'object' });
        flattenDefaults(v, path, depth + 1, walk, out, here);
        continue;
      }
      const leaf = leafOf(v, depth + 1, walk);
      if (leaf !== BAD && here) out.set(path, leaf);
    }
  } finally {
    walk.seen.delete(obj);
  }
}

function leafOf(v: unknown, depth: number, walk: Walk): RbacDefaultEntry | typeof BAD {
  if (v === null) return { kind: 'null' };
  if (typeof v === 'string' || typeof v === 'boolean') return { kind: 'scalar', json: JSON.stringify(v) };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'scalar', json: JSON.stringify(v) } : BAD;
  if (v instanceof Date) {
    const t = Date.prototype.getTime.call(v);
    return Number.isNaN(t) ? BAD : { kind: 'scalar', json: JSON.stringify(new Date(t).toISOString()) };
  }
  if (Array.isArray(v)) return listCopies(v, depth, walk) ? { kind: 'list' } : BAD;
  return BAD;
}

/** Whether the engine keeps the list: every element copyable, nested objects and lists included. */
function listCopies(list: readonly unknown[], depth: number, walk: Walk): boolean {
  enter(list, depth, walk);
  try {
    spend(walk, list.length);
    for (let i = 0; i < list.length; i++) {
      if (!(i in list) || list[i] === undefined) return false;
      const item = list[i];
      // An object in a list is kept (what it cannot hold is dropped), but counts towards the engine's limits.
      if (isPlainObject(item)) flattenDefaults(item, '', depth + 1, walk, new Map(), false);
      else if (leafOf(item, depth + 1, walk) === BAD) return false;
    }
    return true;
  } finally {
    walk.seen.delete(list);
  }
}

/** The scope attribute a block reads, for each row (and rule row) of the query. */
export interface RbacAttrSql {
  /**
   * Two-valued: the engine reads a value there that is not null (a scalar, an object or a list). FALSE also
   * where the SQL cannot read the type's layer (`RbacScopeLayer`): the core may decide there, and refusing is
   * narrower.
   */
  readonly present: RbacSql;
  /** The scalar's JSON text (what `value_json` holds); NULL when not present or not a scalar. */
  readonly json: RbacSql;
  /** The exact number when `json` is a number; else NULL. */
  readonly num: RbacSql;
  /**
   * The same as a one-row derived table with the columns `json`, `num` and `present` (1 or 0): a block that
   * reads the value several times selects from it once, so the attribute is looked up once.
   */
  readonly row: RbacSql;
}

/** One way an attribute reference resolves: the node type, when it applies, the node's id and the attribute path. */
interface Target {
  readonly type: ResourceType;
  readonly applies: RbacSql;
  readonly id: RbacSql;
  readonly path: RbacSql;
  /** The attribute path when it is a constant. */
  readonly constPath?: string;
}

const codePoints = (s: string): number => [...s].length;

/**
 * `scope.<type>.<attributePath>` for each row: the value of the row's nearest node of `type` (`nearestId`;
 * GLOBAL for '$global'), layered as the engine does: the store's row at the path, else nothing when a row sits
 * above it (a scalar replaces the object), else an object when rows sit below it, else the schema default. The
 * type's `RbacScopeLayer` decides which reads are faults. A node id of '' holds no attributes here: '' is the
 * type-only scope's key, and authz-orm's adapter finds no row for it (the engine then faults).
 */
export function attr(path: RbacPathSql, type: ResourceType, attributePath: string, defaults: RbacScopeDefaults, dialect: RbacSqlDialect): RbacAttrSql {
  // The engine's reference parser takes the second segment as the type, so no reference names such a type.
  if (typeof type !== 'string' || type === '' || type.includes('.')) throw new AuthzConfigError(`authz-rbac attr: no scope reference names the type ${JSON.stringify(type)}`);
  const id = type === GLOBAL.type ? rsql`${''}` : path.nearestId(type);
  return attributeOf([{ type, applies: TRUE_SQL, id, path: rsql`${attributePath}`, constPath: attributePath }], defaults, dialect);
}

/**
 * As `attr`, for a column holding the full reference text `scope.<type>.<path>` (a rule's `when_path`): one
 * target per node type of the path and GLOBAL. A type that is no node of the path, or text of another shape,
 * reads nothing (a fault).
 */
export function attrOfRef(path: RbacPathSql, ref: RbacSql, defaults: RbacScopeDefaults, dialect: RbacSqlDialect): RbacAttrSql {
  // The engine reads the second segment as the type: a node type holding '.' is never named, and its prefix
  // would match references to its first part ('scope.a.b.x' is type 'a', path 'b.x').
  const types = [...new Set(path.nodes.map((n) => n.type))].filter((type) => !type.includes('.'));
  const targets = types.map((type): Target => {
    // Without '.' in the types, at most one prefix matches.
    const prefix = `scope.${type}.`;
    const n = codePoints(prefix);
    return {
      type,
      applies: rsql`(${ref} IS NOT NULL AND SUBSTR(${ref}, 1, ${intSql(n)}) = ${prefix})`,
      id: type === GLOBAL.type ? rsql`${''}` : path.nearestId(type),
      path: rsql`SUBSTR(${ref}, ${intSql(n + 1)})`,
    };
  });
  return attributeOf(targets, defaults, dialect);
}

const DIGITS = ['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const firstChar = (json: RbacSql): RbacSql => rsql`SUBSTR(${json}, 1, 1)`;

/** A JSON text the store writes for a scalar: a string, true, false or a number (not null, a list or an object). */
const scalarJson = (json: RbacSql): RbacSql => orSql(rsql`${firstChar(json)} = ${'"'}`, rsql`${json} IN (${['true', 'false']})`, rsql`${firstChar(json)} IN (${DIGITS})`);

const numberJson = (json: RbacSql): RbacSql => rsql`${firstChar(json)} IN (${DIGITS})`;

const as = (expr: RbacSql, name: string): RbacSql => rsql`${expr} AS ${ident(name)}`;
const flag = (cond: RbacSql): RbacSql => rsql`CASE WHEN ${cond} THEN 1 ELSE 0 END`;

/**
 * One-row derived tables, each level naming what the next reads (SQL has no let), so each lookup runs once
 * per row and the scope attribute table is probed by its key (scope_type, scope_id, path):
 * authz_t: which node and path the reference names; authz_y: the store's rows there and the default;
 * authz_x: the engine's layering; the row: json, num, present.
 */
function attributeOf(targets: readonly Target[], defaults: RbacScopeDefaults, dialect: RbacSqlDialect): RbacAttrSql {
  const pick = (value: (t: Target) => RbacSql): RbacSql =>
    targets.length === 1 && targets[0].constPath !== undefined
      ? value(targets[0])
      : rsql`CASE ${joinSql(
          targets.map((t) => rsql`WHEN ${t.applies} THEN ${value(t)}`),
          ' ',
        )} END`;
  const resolved = rsql`SELECT ${joinSql(
    [
      as(
        pick((t) => rsql`${t.type}`),
        't',
      ),
      as(
        pick((t) => t.id),
        'i',
      ),
      as(
        pick((t) => t.path),
        'p',
      ),
      as(
        pick((t) => flag(layerReads(t, defaults.layer(t.type)))),
        'ok',
      ),
    ],
    ', ',
  )}${dialect.fence}`;

  const t = (column: string): RbacSql => rsql`${ident('authz_t', column)}`;
  const sa = (column: string): RbacSql => rsql`${ident(SA, column)}`;
  const node = rsql`${ident(SCOPE_ATTRIBUTE_TABLE)} ${ident(SA)} WHERE ${sa('scope_type')} = ${t('t')} AND ${sa('scope_id')} = ${t('i')}`;
  // GLOBAL's key is ('$global', ''); any other node needs an id, and '' is the type-only scope's key.
  const nodeOk = andSql(rsql`${t('ok')} = 1`, rsql`${t('i')} IS NOT NULL`, orSql(rsql`${t('t')} = ${GLOBAL.type}`, rsql`${t('i')} <> ${''}`));
  const value = rsql`(SELECT ${sa('value_json')} FROM ${node} AND ${sa('path')} = ${t('p')})`;
  const above = rsql`EXISTS (SELECT 1 FROM ${node} AND LENGTH(${sa('path')}) < LENGTH(${t('p')}) AND SUBSTR(${t('p')}, 1, LENGTH(${sa('path')}) + 1) = ${sa('path')} || ${'.'})`;
  const below = rsql`EXISTS (SELECT 1 FROM ${node} AND SUBSTR(${sa('path')}, 1, LENGTH(${t('p')}) + 1) = ${t('p')} || ${'.'})`;
  const { code: defaultCode, json: defaultJson } = defaultsOf(targets, defaults, t('t'), t('p'));
  const lookup = rsql`SELECT ${joinSql([as(flag(nodeOk), 'node'), as(value, 'v'), as(flag(above), 'above'), as(flag(below), 'below'), as(defaultCode, 'dcode'), as(defaultJson, 'djson')], ', ')} FROM (${resolved}) ${ident('authz_t')}${dialect.fence}`;

  const y = (column: string): RbacSql => rsql`${ident('authz_y', column)}`;
  // Codes: 1 a scalar, 2 an object or a list, NULL nothing (missing, null, or a row the store would not write).
  const code = rsql`CASE WHEN ${y('node')} = 0 THEN NULL WHEN ${y('v')} IS NOT NULL THEN (CASE WHEN ${scalarJson(y('v'))} THEN 1 END) WHEN ${y('above')} = 1 THEN NULL WHEN ${y('below')} = 1 THEN 2 ELSE ${y('dcode')} END`;
  const json = rsql`CASE WHEN ${y('node')} = 0 THEN NULL WHEN ${y('v')} IS NOT NULL THEN (CASE WHEN ${scalarJson(y('v'))} THEN ${y('v')} END) WHEN ${y('above')} = 1 OR ${y('below')} = 1 THEN NULL ELSE ${y('djson')} END`;
  const layered = rsql`SELECT ${as(code, 'code')}, ${as(json, 'json')} FROM (${lookup}) ${ident('authz_y')}${dialect.fence}`;

  const x = (column: string): RbacSql => rsql`${ident('authz_x', column)}`;
  const num = rsql`CASE WHEN ${numberJson(x('json'))} THEN ${dialect.number(x('json'))} END`;
  const row = rsql`(SELECT ${as(x('json'), 'json')}, ${as(num, 'num')}, ${as(rsql`CASE WHEN ${x('code')} IS NOT NULL THEN 1 ELSE 0 END`, 'present')} FROM (${layered}) ${ident('authz_x')}${dialect.fence})`;
  const read = (column: string): RbacSql => rsql`(SELECT ${ident('authz_z', column)} FROM ${row} ${ident('authz_z')})`;
  return { present: rsql`(${read('present')} = 1)`, json: read('json'), num: read('num'), row };
}

/** Two-valued: the type's layer lets the SQL read this attribute of the node (else the read is a fault). */
function layerReads(t: Target, layer: RbacScopeLayer | undefined): RbacSql {
  if (layer === undefined) return FALSE_SQL;
  if (layer.kind === 'store') return TRUE_SQL;
  if (layer.exists === undefined) return FALSE_SQL;
  const own = (name: string): RbacSql => (t.constPath !== undefined ? (t.constPath === name || t.constPath.startsWith(`${name}.`) ? TRUE_SQL : FALSE_SQL) : orSql(rsql`${t.path} = ${name}`, rsql`SUBSTR(${t.path}, 1, ${intSql(codePoints(name) + 1)}) = ${`${name}.`}`));
  const owned = layer.attributes.map(own);
  return andSql(rsql`${t.id} IS NOT NULL`, notSql(orSql(...owned)), layer.exists(t.id));
}

/** The default's code (1 scalar, 2 object or list) and JSON text for the resolved type and path, NULL where there is none. */
function defaultsOf(targets: readonly Target[], defaults: RbacScopeDefaults, type: RbacSql, path: RbacSql): { code: RbacSql; json: RbacSql } {
  const codes: RbacSql[] = [];
  const jsons: RbacSql[] = [];
  for (const target of targets) {
    const entries: ReadonlyArray<readonly [string, RbacDefaultEntry | undefined]> = target.constPath === undefined ? [...defaults.entries(target.type)] : [[target.constPath, defaults.lookup(target.type, target.constPath)]];
    for (const [at, entry] of entries) {
      if (entry === undefined || entry.kind === 'null') continue;
      const when = target.constPath === undefined ? rsql`${type} = ${target.type} AND ${path} = ${at}` : TRUE_SQL;
      codes.push(rsql`WHEN ${when} THEN ${intSql(entry.kind === 'scalar' ? 1 : 2)}`);
      if (entry.kind === 'scalar') jsons.push(rsql`WHEN ${when} THEN ${entry.json}`);
    }
  }
  return {
    code: codes.length === 0 ? rsql`CAST(NULL AS INTEGER)` : rsql`CASE ${joinSql(codes, ' ')} END`,
    json: jsons.length === 0 ? rsql`CAST(NULL AS TEXT)` : rsql`CASE ${joinSql(jsons, ' ')} END`,
  };
}
