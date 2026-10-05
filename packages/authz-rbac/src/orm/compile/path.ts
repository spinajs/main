import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { IdentifierQuoter } from '@spinajs/orm';

import type { RbacIdMode, RbacScopePath } from '../scope-path.js';
import type { RbacSqlDialect } from './dialect.js';
import { FALSE_SQL, andSql, ident, intSql, joinSql, notSql, orSql, outer, rsql, textOf } from './sql.js';
import type { RbacIdentifier, RbacSql } from './sql.js';

/** A node of a row's path: the row itself, an ancestor read from a scope column, or GLOBAL (no column). */
export interface RbacPathNode {
  readonly type: ResourceType;
  /** Column of the scoped table holding the node's id; absent for GLOBAL. */
  readonly column?: string;
  /** How the adapter reads the column's value as an id; absent: any non-NULL value, as its text cast. */
  readonly idMode?: RbacIdMode;
}

const refuse = (why: string): AuthzConfigError => new AuthzConfigError(`authz-rbac path sql: ${why}`);

const named = (name: unknown): name is string => typeof name === 'string' && name !== '';

const MODES: ReadonlySet<unknown> = new Set<RbacIdMode>(['string', 'number', 'text', 'none']);

// The key rows of a model registered before the filtered one (`whenFound`).
const SHADOW = 'authz_f';

/**
 * The scope path of a row (§12.4 `onPath`, `below`) as SQL over the `scope_type` / `scope_id` columns
 * of an assignment or rule row under an alias, the filtered row's columns given by `outer()`.
 *
 * Reference: `resourcePath` (model/evaluate.ts) over the ancestors authz-orm's adapter gives: a scope
 * column whose value is no id of its mode (NULL included) is no ancestor, a node repeated by key
 * counts at its nearest occurrence, GLOBAL last. Indexes are static, `nodes[i]` whatever the row holds:
 * they keep the evaluator's order (equal iff same node) but skip no number for a missing ancestor or a
 * repeated node.
 *
 * Id modes (`RbacScopePath.idMode`, `RbacScopeColumn.idMode`, from authz-orm) need the connection's
 * dialect. A column with a mode is a node exactly when the adapter lists it, with one exception: a
 * `number` id that is not an integer, which SQL cannot print as JavaScript does, names no node. Without
 * a mode the column is compared as its text cast, which is wider than the adapter for a value outside
 * the column's mode.
 *
 * Every predicate is two-valued (TRUE or FALSE, never NULL), also when the alias's scope columns are
 * NULL: such a row names no scope. Each comes parenthesised. So a block is exact only for a row
 * `whenFound` lets through: a term built from the blocks must sit inside `whenFound`, which makes it
 * UNKNOWN for every other row (no row the adapter finds, an earlier model of the type holding the id, a
 * non-integer number id on the path). Then the term stays narrower under NOT as well.
 */
export class RbacPathSql {
  readonly nodes: readonly RbacPathNode[];

  constructor(readonly path: RbacScopePath, private readonly quoter: IdentifierQuoter, private readonly dialect?: RbacSqlDialect) {
    if (!named(path.type) || path.type === GLOBAL.type) throw refuse(`a path needs a resource type other than ${GLOBAL.type}, got '${String(path.type)}'`);
    if (!named(path.idColumn)) throw refuse(`the path of ${path.type} has no id column`);
    for (const s of path.scopes) {
      if (!named(s.column)) throw refuse(`a scope column of ${path.type} has no name`);
      if (!named(s.scopeType) || s.scopeType === GLOBAL.type) throw refuse(`scope column ${s.column} of ${path.type} needs a scope type other than ${GLOBAL.type}, got '${String(s.scopeType)}'`);
    }
    const modes = [path.idMode, ...path.scopes.map((s) => s.idMode)].filter((m) => m !== undefined);
    if (modes.some((m) => !MODES.has(m))) throw refuse(`the path of ${path.type} has an id mode other than ${[...MODES].join(', ')}`);
    if (modes.length > 0 && dialect === undefined) throw refuse(`the path of ${path.type} has id modes, which need the connection's dialect`);
    const earlier = path.earlierKeys ?? [];
    if (earlier.length > 0 && path.idMode === undefined) throw refuse(`the path of ${path.type} names earlier models, which needs the id mode of its own key`);
    for (const k of earlier) if (k !== null && (!named(k.table) || !named(k.idColumn) || !MODES.has(k.idMode))) throw refuse(`an earlier model key of ${path.type} needs a table, a key column and an id mode`);
    const node = (type: ResourceType, column: string, idMode: RbacIdMode | undefined): RbacPathNode => (idMode === undefined ? { type, column } : { type, column, idMode });
    this.nodes = Object.freeze([node(path.type, path.idColumn, path.idMode), ...path.scopes.map((s) => node(s.scopeType, s.column, s.idMode)), { type: GLOBAL.type }].map((n) => Object.freeze(n)));
  }

  /**
   * `x` names node `i`: GLOBAL by `scope_type = '$global'`, any other node by its type and the id the
   * adapter reads from its column. An empty `scope_id` is a type-only scope, never a node, also when
   * the column holds ''.
   */
  atNode(x: string, i: number): RbacSql {
    const node = this.nodes[this.index(i)];
    const { type, id } = this.scope(x);
    const known = rsql`${type} IS NOT NULL AND ${id} IS NOT NULL`;
    if (node.column === undefined) return rsql`(${known} AND ${type} = ${GLOBAL.type})`;
    if (node.idMode === 'none') return rsql`(${FALSE_SQL})`;
    const column = rsql`${outer(node.column)}`;
    if (node.idMode === undefined) return rsql`(${known} AND ${type} = ${node.type} AND ${id} <> ${''} AND ${column} IS NOT NULL AND ${id} = ${textOf(column, this.quoter)})`;
    const read = this.dialect!.idOf(column, node.idMode);
    return rsql`(${known} AND ${type} = ${node.type} AND ${id} <> ${''} AND ${read.exact} AND ${this.dialect!.sameText(rsql`${id}`, read.text)})`;
  }

  /**
   * Integer: the static index (`nodes[i]`) of the nearest node `x` names, NULL when it names none (off
   * the path, or type-only). Not two-valued. Only compare it with another `pathIndex` of the same
   * path, never with an evaluator-side position, which skips missing ancestors and repeated nodes.
   * Where a `number` column holds an id that is not an integer, `x` naming that node by its id may get
   * the index of a farther column holding the same id as a string; `whenFound` makes such a row UNKNOWN.
   */
  pathIndex(x: string): RbacSql {
    return this.indexOr(x);
  }

  /** `x` names a node of the path. */
  onPathNode(x: string): RbacSql {
    return orSql(...this.nodes.map((_, i) => this.atNode(x, i)));
  }

  /**
   * `scopeMatcher` (model/native.ts): a node, or the type-only scope of the row's own type. For a row
   * the adapter cannot find (see `whenFound`) the evaluator has no path at all.
   */
  onPath(x: string): RbacSql {
    const { type, id } = this.scope(x);
    return orSql(this.onPathNode(x), rsql`${type} IS NOT NULL AND ${id} IS NOT NULL AND ${type} = ${this.path.type} AND ${id} = ${''}`);
  }

  /**
   * `cond` where the blocks read the row's path as the evaluator does, NULL (UNKNOWN) elsewhere. Not
   * two-valued, on purpose: under NOT those rows stay out. `cond` itself when the id column has no mode.
   * NULL where:
   * - the adapter cannot find the row by its id (`ancestors` answers null, the evaluator throws);
   * - a model of the type registered earlier holds the same id (`findRow` takes that model's row and
   *   its path), may hold it (a number id SQL cannot print), or lives where this SQL cannot look;
   * - the row's id or a scope column holds a `number` id that is not an integer (no block names it).
   */
  whenFound(cond: RbacSql): RbacSql {
    const mode = this.path.idMode;
    if (mode === undefined) return cond;
    return rsql`(CASE WHEN ${this.found(mode)} THEN (CASE WHEN ${cond} THEN 1 ELSE 0 END) END = 1)`;
  }

  private found(mode: RbacIdMode): RbacSql {
    const earlier = this.path.earlierKeys ?? [];
    if (mode === 'none' || earlier.includes(null)) return FALSE_SQL;
    const d = this.dialect!;
    const own = d.idOf(rsql`${outer(this.path.idColumn)}`, mode);
    // holds without exact: an id of the mode that SQL cannot print, so no block names it.
    const exactPath = this.nodes.flatMap((n) => (n.column !== undefined && n.idMode === 'number' && n !== this.nodes[0] ? [d.idOf(rsql`${outer(n.column)}`, 'number')] : [])).map((r) => rsql`(NOT ${r.holds} OR ${r.exact})`);
    const unshadowed = earlier.flatMap((k) => {
      if (k === null || k.idMode === 'none') return [];
      const theirs = d.idOf(rsql`${ident(SHADOW, k.idColumn)}`, k.idMode);
      const same = d.sameText(theirs.text, own.text);
      // Their non-integer number id SQL cannot print: it never equals our integer one, but may equal a string id.
      const holdsIt = k.idMode === 'number' && mode !== 'number' ? orSql(notSql(theirs.exact), same) : rsql`${theirs.exact} AND ${same}`;
      return [rsql`NOT EXISTS (SELECT 1 FROM ${ident(k.table)} ${ident(SHADOW)} WHERE ${theirs.findable} AND ${holdsIt})`];
    });
    return andSql(own.findable, own.exact, ...exactPath, ...unshadowed);
  }

  /** `x` names a node strictly below `a`'s node (nearer the row); FALSE unless both name nodes. */
  below(a: string, x: string): RbacSql {
    // The fallbacks make the comparison FALSE when either side names no node.
    return rsql`(${this.indexOr(x, this.nodes.length)} < ${this.indexOr(a, -1)})`;
  }

  /**
   * What a restrict rule at `n` keeps (rule steps, `applyRestrict`): `a` names a node not above `n`'s
   * node. FALSE when `a` names no node (a type-only scope counts as above every node) or `n` names none.
   */
  notAbove(a: string, n: string): RbacSql {
    return rsql`(${this.indexOr(a, this.nodes.length)} <= ${this.indexOr(n, -1)})`;
  }

  /**
   * Text: the id of the nearest node of `type` the adapter lists, '' included (what the evaluator's
   * `path.find` of a node of that type with an id gives); NULL when there is none, and NULL (not a
   * farther node) where the nearest one is a `number` id that is not an integer. Not two-valued. A ''
   * id read as `(type, scope_id)` would name the type-only scope (stored as `(type, '')`): a caller
   * looking up scope rows by it must decide that case against the evaluator.
   */
  nearestId(type: ResourceType): RbacSql {
    const whens = this.nodes.flatMap((n) => {
      if (n.type !== type || n.column === undefined || n.idMode === 'none') return [];
      const column = rsql`${outer(n.column)}`;
      if (n.idMode === undefined) return [rsql`WHEN ${column} IS NOT NULL THEN ${textOf(column, this.quoter)}`];
      const read = this.dialect!.idOf(column, n.idMode);
      return [rsql`WHEN ${read.holds} THEN ${read.text}`];
    });
    if (whens.length === 0) return textOf(rsql`NULL`, this.quoter);
    return rsql`CASE ${joinSql(whens, ' ')} END`;
  }

  /** CASE over the nodes nearest first, so a repeated node counts at its nearest index. */
  private indexOr(x: string, fallback?: number): RbacSql {
    const whens = this.nodes.map((_, i) => rsql`WHEN ${this.atNode(x, i)} THEN ${intSql(i)}`);
    const otherwise = fallback === undefined ? rsql`` : rsql` ELSE ${intSql(fallback)}`;
    return rsql`CASE ${joinSql(whens, ' ')}${otherwise} END`;
  }

  private index(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.nodes.length) throw refuse(`no node ${i} on the path of ${this.path.type} (${this.nodes.length} nodes)`);
    return i;
  }

  private scope(x: string): { type: RbacIdentifier; id: RbacIdentifier } {
    if (!named(x)) throw refuse('an alias must be a non-empty name');
    return { type: ident(x, 'scope_type'), id: ident(x, 'scope_id') };
  }
}
