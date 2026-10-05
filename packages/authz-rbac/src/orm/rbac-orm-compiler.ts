import { AuthzClock, AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { Container, Inject, Injectable } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase, OrmDriver } from '@spinajs/orm';

import { RBAC_ASSIGNMENT_OP } from '../contracts.js';
import { parseRbacAssignmentArgs } from '../model/native.js';
import type { RbacArgsSubject, RbacAssignmentArgs } from '../model/native.js';
import { rbacDialectOf } from './compile/dialect.js';
import { RbacPathSql } from './compile/path.js';
import { FALSE_SQL, andSql, ident, inList, orSql, rsql, whereRbacSql } from './compile/sql.js';
import type { RbacSql } from './compile/sql.js';
import { RbacRoleGraphSource, isEmptyRoleScopes, rbacRoleScopes } from './role-graph.js';
import type { RbacRoleScopes } from './role-graph.js';
import { RbacScopePathSource } from './scope-path.js';
import type { RbacScopePath } from './scope-path.js';

export const AUTHZ_ASSIGNMENT_TABLE = 'authz_assignment';

/** One `native:rbac.assignment` term, ready for SQL: the args' subjects as columns, their roles checked against the role definitions. */
export interface RbacAssignmentTerm {
  readonly subjects: readonly RbacSubjectTriple[];
  readonly roles: RbacRoleScopes;
}

/** A subject as the `authz_assignment` subject columns hold it. */
export interface RbacSubjectTriple {
  readonly type: string;
  readonly id: string;
  /** `''` for a principal. */
  readonly role: string;
}

interface BuilderLinks {
  readonly Driver?: OrmDriver;
  readonly Parent?: BuilderLinks;
}

/**
 * `native:rbac.assignment` (args: model/native.ts) → the `EXISTS` over `authz_assignment` of §6.1.3:
 * `subjectIn AND roleIn AND live AND onPath`, as one `RbacSql` fragment: through authz-orm's
 * `whereSql` in a native compilation, as plain SQL on any other builder (`whereRbacSql`). The blocks
 * are separate methods so the rule compilation of §12.4 can reuse and wrap them.
 */
@Injectable(OrmNativeCompiler)
@Inject(Container)
export class RbacOrmCompiler extends OrmNativeCompiler {
  readonly op = RBAC_ASSIGNMENT_OP;

  protected readonly table: string = AUTHZ_ASSIGNMENT_TABLE;
  // Distinct from usual table aliases: a filtered row under the same alias is refused.
  protected readonly alias: string = 'authz_a';

  constructor(protected readonly container: IContainer) {
    super();
  }

  compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, _principal: Principal): void {
    const parsed = this.parseArgs(args);
    const path = this.pathSql(builder, this.pathOf(model));
    // Mapped before any SQL, so a bad subject throws from compile().
    const subjects = parsed.subjects.map((s) => this.subjectTriple(s));
    // The evaluator answers false before it reads the path.
    if (parsed.roles.length === 0 || subjects.length === 0) {
      whereRbacSql(builder, FALSE_SQL);
      return;
    }

    const roles = this.roleScopes(model, parsed.roles);
    whereRbacSql(builder, isEmptyRoleScopes(roles) ? path.whenFound(FALSE_SQL) : this.assignmentSql({ subjects, roles }, path, this.now()));
  }

  /** Adds the term's `EXISTS (SELECT 1 FROM authz_assignment <alias> WHERE …)` to `builder`, about the row it filters. */
  assignmentExists(builder: IWhereBuilder<unknown>, term: RbacAssignmentTerm, path: RbacScopePath, now: Date, alias: string = this.alias): void {
    whereRbacSql(builder, this.assignmentSql(term, this.pathSql(builder, path), now, alias));
  }

  /**
   * The term as one fragment, under `whenFound`: a row the adapter cannot find by its id is UNKNOWN, as
   * in the evaluator (with the id modes authz-orm's path gives). FALSE for no subjects or no roles.
   */
  assignmentSql(term: RbacAssignmentTerm, path: RbacPathSql, now: Date, alias: string = this.alias): RbacSql {
    const where = andSql(this.subjectIn(term.subjects, alias), this.roleIn(term.roles, alias), this.live(now, alias), this.onPath(path, alias));
    return path.whenFound(rsql`EXISTS (SELECT 1 FROM ${ident(this.table)} ${ident(alias)} WHERE ${where})`);
  }

  /** OR of `(subject_type, subject_id, subject_role)` equality triples; row-value `IN` is not portable. */
  subjectIn(subjects: readonly RbacSubjectTriple[], alias: string = this.alias): RbacSql {
    const a = (column: string) => ident(alias, column);
    return orSql(...subjects.map((s) => rsql`${a('subject_type')} = ${s.type} AND ${a('subject_id')} = ${s.id} AND ${a('subject_role')} = ${s.role}`));
  }

  /** `role IN (:anyScope) OR (role = :r AND scope_type IN (:scopeTypes)) OR …`; FALSE for no roles. */
  roleIn(roles: RbacRoleScopes, alias: string = this.alias): RbacSql {
    const role = rsql`${ident(alias, 'role')}`;
    const parts: RbacSql[] = [];
    if (roles.anyScope.length > 0) parts.push(inList(role, roles.anyScope));
    for (const r of roles.scoped) parts.push(rsql`${role} = ${r.role} AND ${inList(rsql`${ident(alias, 'scope_type')}`, r.scopeTypes)}`);
    return orSql(...parts);
  }

  /** Not expired at `now`: the authz clock's time, not the database's. */
  live(now: Date, alias: string = this.alias): RbacSql {
    const expires = rsql`${ident(alias, 'expires_at')}`;
    return rsql`(${expires} IS NULL OR ${expires} > ${now})`;
  }

  /** `$global`, the type-only scope of the row's type, the row itself, then every scope column of the path. */
  onPath(path: RbacPathSql, alias: string = this.alias): RbacSql {
    return path.onPath(alias);
  }

  /** As the assignment store writes subjects: a principal `(type, id, '')`, a set `(scope.type, scope.id ?? '', role)`. */
  protected subjectTriple(s: RbacArgsSubject): RbacSubjectTriple {
    if (!('set' in s)) return { type: s.type, id: s.id, role: '' };
    const { role, scope } = s.set;
    if (role === '') throw new AuthzConfigError(`${this.op}: a subject set at ${scope.type}:${scope.id ?? ''} has an empty role; it would match the principal`);
    return { type: scope.type, id: scope.type === GLOBAL.type ? '' : scope.id ?? '', role };
  }

  /** The path's SQL on `builder`'s connection; id modes need its dialect (SQLite or Postgres). */
  protected pathSql(builder: IWhereBuilder<unknown>, path: RbacScopePath): RbacPathSql {
    const driver = this.driverOf(builder);
    const modes = path.idMode !== undefined || path.scopes.some((s) => s.idMode !== undefined);
    return new RbacPathSql(path, driver.Container.resolve(IdentifierQuoter), modes ? rbacDialectOf(driver) : undefined);
  }

  /** L1's parser: anything but the exact v1 shape (another `v`, unknown keys, non-canonical order) is refused. */
  protected parseArgs(args: unknown): RbacAssignmentArgs {
    try {
      return parseRbacAssignmentArgs(args);
    } catch (e) {
      throw new AuthzConfigError(e instanceof Error ? e.message : `${this.op}: malformed args`, { cause: e });
    }
  }

  protected roleScopes(model: Class<ModelBase>, roles: readonly string[]): RbacRoleScopes {
    if (!this.container.hasRegistered(RbacRoleGraphSource)) {
      throw new AuthzConfigError(`${this.op}: no RbacRoleGraphSource is registered; the host registers one for its RbacModel`);
    }

    const graph = this.container.resolve(RbacRoleGraphSource).graph(model);
    if (!graph) throw new AuthzConfigError(`${this.op}: no role definitions for model ${model.name}: not compiled yet, or the RbacRoleGraphSource does not serve it`);
    return rbacRoleScopes(graph, roles);
  }

  protected now(): Date {
    return this.container.resolve(AuthzClock).now();
  }

  protected pathOf(model: Class<ModelBase>): RbacScopePath {
    if (!this.container.hasRegistered(RbacScopePathSource)) {
      throw new AuthzConfigError(`${this.op}: no RbacScopePathSource is registered`);
    }

    const path = this.container.resolve(RbacScopePathSource).path(model);
    if (!path) {
      throw new AuthzConfigError(`${this.op}: model ${model.name} has no RBAC scope path (is it an @AccessResource?)`);
    }

    return path;
  }

  /** The connection of the query a (possibly nested) where builder belongs to. */
  protected driverOf(builder: IWhereBuilder<unknown>): OrmDriver {
    for (let b: BuilderLinks | undefined = builder as BuilderLinks; b; b = b.Parent) {
      if (b.Driver) return b.Driver;
    }
    throw new AuthzConfigError(`${this.op}: the where builder is not attached to a query`);
  }
}
