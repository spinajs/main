import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { IdentifierQuoter } from '@spinajs/orm';

import type { RbacScopePath } from '../scope-path.js';
import { ident, intSql, joinSql, orSql, outer, rsql, textOf } from './sql.js';
import type { RbacIdentifier, RbacSql } from './sql.js';

/** A node of a row's path: the row itself, an ancestor read from a scope column, or GLOBAL (no column). */
export interface RbacPathNode {
  readonly type: ResourceType;
  /** Column of the scoped table holding the node's id; absent for GLOBAL. */
  readonly column?: string;
}

const refuse = (why: string): AuthzConfigError => new AuthzConfigError(`authz-rbac path sql: ${why}`);

const named = (name: unknown): name is string => typeof name === 'string' && name !== '';

/**
 * The scope path of a row (§12.4 `onPath`, `below`) as SQL over the `scope_type` / `scope_id` columns
 * of an assignment or rule row under an alias, the filtered row's columns given by `outer()`.
 *
 * Reference: `resourcePath` (model/evaluate.ts) over the ancestors authz-orm's adapter gives: a NULL
 * scope column is no ancestor, a node repeated by key counts at its nearest occurrence, GLOBAL last.
 * Indexes are static, `nodes[i]` whatever the row holds: they keep the evaluator's order (equal iff
 * same node) but skip no number for a NULL column or a repeated node.
 *
 * Every predicate is two-valued (TRUE or FALSE, never NULL), also when the alias's scope columns are
 * NULL: such a row names no scope. Each comes parenthesised.
 */
export class RbacPathSql {
  readonly nodes: readonly RbacPathNode[];

  constructor(readonly path: RbacScopePath, private readonly quoter: IdentifierQuoter) {
    if (!named(path.type) || path.type === GLOBAL.type) throw refuse(`a path needs a resource type other than ${GLOBAL.type}, got '${String(path.type)}'`);
    if (!named(path.idColumn)) throw refuse(`the path of ${path.type} has no id column`);
    for (const s of path.scopes) {
      if (!named(s.column)) throw refuse(`a scope column of ${path.type} has no name`);
      if (!named(s.scopeType) || s.scopeType === GLOBAL.type) throw refuse(`scope column ${s.column} of ${path.type} needs a scope type other than ${GLOBAL.type}, got '${String(s.scopeType)}'`);
    }
    this.nodes = Object.freeze([{ type: path.type, column: path.idColumn }, ...path.scopes.map((s) => ({ type: s.scopeType, column: s.column })), { type: GLOBAL.type }].map((n) => Object.freeze(n)));
  }

  /**
   * `x` names node `i`: GLOBAL by `scope_type = '$global'`, any other node by its type and the text of
   * its column. An empty `scope_id` is a type-only scope, never a node, also when the column holds ''.
   *
   * Known gap (tracked as a hand-off): the adapter's id modes are not applied yet. authz-orm gives no
   * ancestor for a value outside its column's id mode (text in an integer column, a 'none'-mode
   * column) or for an integer beyond the safe range, while `CAST(col AS TEXT)` matches all of them;
   * there the SQL is wider than the evaluator.
   */
  atNode(x: string, i: number): RbacSql {
    const node = this.nodes[this.index(i)];
    const { type, id } = this.scope(x);
    const known = rsql`${type} IS NOT NULL AND ${id} IS NOT NULL`;
    if (node.column === undefined) return rsql`(${known} AND ${type} = ${GLOBAL.type})`;
    const column = rsql`${outer(node.column)}`;
    return rsql`(${known} AND ${type} = ${node.type} AND ${id} <> ${''} AND ${column} IS NOT NULL AND ${id} = ${textOf(column, this.quoter)})`;
  }

  /**
   * Integer: the static index (`nodes[i]`) of the nearest node `x` names, NULL when it names none (off
   * the path, or type-only). Not two-valued. Only compare it with another `pathIndex` of the same
   * path, never with an evaluator-side position, which skips NULL columns and repeated nodes.
   */
  pathIndex(x: string): RbacSql {
    return this.indexOr(x);
  }

  /** `x` names a node of the path. */
  onPathNode(x: string): RbacSql {
    return orSql(...this.nodes.map((_, i) => this.atNode(x, i)));
  }

  /** `scopeMatcher` (model/native.ts): a node, or the type-only scope of the row's own type. */
  onPath(x: string): RbacSql {
    const { type, id } = this.scope(x);
    return orSql(this.onPathNode(x), rsql`${type} IS NOT NULL AND ${id} IS NOT NULL AND ${type} = ${this.path.type} AND ${id} = ${''}`);
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
   * Text: the id of the nearest node of `type` whose column is not NULL, '' included (what the
   * evaluator's `path.find` of a node of that type with an id gives); NULL when there is none. Not
   * two-valued. A '' id read as `(type, scope_id)` would name the type-only scope (stored as
   * `(type, '')`): a caller looking up scope rows by it must decide that case against the evaluator.
   */
  nearestId(type: ResourceType): RbacSql {
    const whens = this.nodes
      .filter((n): n is Required<RbacPathNode> => n.type === type && n.column !== undefined)
      .map((n) => {
        const column = rsql`${outer(n.column)}`;
        return rsql`WHEN ${column} IS NOT NULL THEN ${textOf(column, this.quoter)}`;
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
