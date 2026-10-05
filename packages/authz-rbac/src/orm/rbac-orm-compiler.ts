import { AuthzClock, AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { Configuration } from '@spinajs/configuration';
import { Container, Inject, Injectable } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase, OrmDriver } from '@spinajs/orm';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../contracts.js';
import { parseRbacAssignmentArgs } from '../model/native.js';
import type { RbacArgsSubject, RbacAssignmentArgs } from '../model/native.js';
import { parseRbacListArgs } from '../model/rules/args.js';
import type { RbacAssignmentArgsV2, RbacListContext, RbacThresholdArgs } from '../model/rules/args.js';
import type { RoleGraph } from '../model/roles.js';
import { RbacScopeAttributeSource, RbacScopeDefaults } from './compile/attributes.js';
import { rbacDialectOf } from './compile/dialect.js';
import { RbacPathSql } from './compile/path.js';
import { rbacRoutePlan } from './compile/route.js';
import type { RbacRouteNeed, RbacRoutePlan } from './compile/route.js';
import { RbacRulesSql, rbacResourceFields } from './compile/rules.js';
import { FALSE_SQL, TRUE_SQL, andSql, ident, inList, notSql, orSql, rsql, whereRbacSql } from './compile/sql.js';
import type { RbacSql } from './compile/sql.js';
import { ormRbacScopeLayers } from './orm-sources.js';
import { RbacRoleGraphSource, isEmptyRoleScopes, rbacRoleScopes } from './role-graph.js';
import type { RbacListing, RbacRoleScopes } from './role-graph.js';
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

/** What `routeSql` reads beside the plan. */
export interface RbacRouteSqlContext {
  readonly graph: RoleGraph;
  readonly subjects: readonly RbacSubjectTriple[];
  readonly path: RbacPathSql;
  readonly now: Date;
  /** The dialect's case-sensitive substring test (`RbacSqlDialect.contains`). */
  readonly contains: (haystack: RbacSql, needle: RbacSql) => RbacSql;
}

interface BuilderLinks {
  readonly Driver?: OrmDriver;
  readonly Parent?: BuilderLinks;
}

/**
 * What the native compilers of authz-rbac share: the model's scope path, role graph and listing (host sources),
 * the authz clock, and the SQL of list terms with bound rules (`RbacRulesSql`). Each compiler reads the
 * principal only from its args, never from the request principal it is handed (RFC E2-2).
 *
 * Postgres: the rule terms have a high estimated cost and with the default `jit_above_cost` the server
 * JIT-compiles every list query for seconds (25-30 s measured for 3.4 ms of work). Hosts set `jit = off`, or a
 * `jit_above_cost` above these plans' cost, for the role or database of the authz connection.
 */
export abstract class RbacListCompiler extends OrmNativeCompiler {
  protected readonly table: string = AUTHZ_ASSIGNMENT_TABLE;

  constructor(protected readonly container: IContainer) {
    super();
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

  /** The graph and tables of the model whose residuals reach SQL for `model`. */
  protected listing(model: Class<ModelBase>): RbacListing {
    if (!this.container.hasRegistered(RbacRoleGraphSource)) {
      throw new AuthzConfigError(`${this.op}: no RbacRoleGraphSource is registered; the host registers one for its RbacModel`);
    }
    const listing = this.container.resolve(RbacRoleGraphSource).listing?.(model);
    if (!listing) throw new AuthzConfigError(`${this.op}: args v2 need the role graph with its grant index and tables for model ${model.name}; the RbacRoleGraphSource does not give them (listing), or not yet`);
    return listing;
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

  /** The list terms of `args` (bound config rules) on rows of `model`, on `builder`'s connection. */
  protected rulesSql(builder: IWhereBuilder<unknown>, model: Class<ModelBase>, args: RbacListContext): RbacRulesSql {
    const pathOf = this.pathOf(model);
    const driver = this.driverOf(builder);
    const dialect = rbacDialectOf(driver);
    return new RbacRulesSql({
      listing: this.listing(model),
      args,
      rowType: pathOf.type,
      path: new RbacPathSql(pathOf, driver.Container.resolve(IdentifierQuoter), dialect),
      dialect,
      defaults: this.scopeDefaults(model, driver),
      fields: rbacResourceFields(model, dialect.name),
      now: this.now(),
      subjects: args.subjects.map((s) => this.subjectTriple(s)),
      table: this.table,
      where: this.where(pathOf.type),
    });
  }

  /** The host's `RbacScopeAttributeSource`, else no schema defaults and the layers authz-orm serves (GLOBAL is `store`). */
  protected scopeDefaults(model: Class<ModelBase>, driver: OrmDriver): RbacScopeDefaults {
    const source = this.container.hasRegistered(RbacScopeAttributeSource) ? this.container.resolve(RbacScopeAttributeSource).defaults(model, driver) : undefined;
    return source ?? RbacScopeDefaults.of(undefined, ormRbacScopeLayers(driver));
  }

  /** The op, the domain authz-orm scopes queries for, and the row type, for refusals. */
  protected where(type: string): string {
    let domain: unknown;
    try {
      domain = (this.container.get(Configuration) as Configuration | null)?.get(['authz', 'orm', 'domain']);
    } catch {
      domain = undefined;
    }
    return `${this.op} (domain ${JSON.stringify(typeof domain === 'string' ? domain : 'root')}, type '${type}')`;
  }
}

/**
 * `native:rbac.assignment` (args: model/native.ts) → the `EXISTS` over `authz_assignment` of §6.1.3:
 * `subjectIn AND roleIn AND live AND onPath`, as one `RbacSql` fragment: through authz-orm's
 * `whereSql` in a native compilation, as plain SQL on any other builder (`whereRbacSql`). The blocks
 * are separate methods so the rule compilation of §12.4 can reuse and wrap them. Args v2
 * (model/rules/args.ts) without rules compile to the route term of §12.4 (`compileRoute`).
 */
@Injectable(OrmNativeCompiler)
@Inject(Container)
export class RbacOrmCompiler extends RbacListCompiler {
  readonly op = RBAC_ASSIGNMENT_OP;

  // Distinct from usual table aliases: a filtered row under the same alias is refused.
  protected readonly alias: string = 'authz_a';
  // The tag sub-query of a route, beside the holder's (design §12.4 `b`).
  protected readonly tagAlias: string = 'authz_b';

  constructor(container: IContainer) {
    super(container);
  }

  /** Reads the principal only from the args (its subjects, config roles and ceiling), never from `_principal`. */
  compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, _principal: Principal): void {
    if ((args as { v?: unknown } | null)?.v === 2) {
      this.compileRoute(args, builder, model);
      return;
    }
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

  /**
   * Args v2 (model/rules/args.ts): the route term of design §12.4. Without rules `rbacRoutePlan` turned into SQL by
   * `routeSql`; with bound config rules `RbacRulesSql`. Stored rules (`dbRules`) are refused (the next L4b task).
   */
  protected compileRoute(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>): void {
    const parsed = this.parseRouteArgs(args);
    if (parsed.rules.length > 0 || parsed.dbRules) {
      whereRbacSql(builder, this.rulesSql(builder, model, parsed).route(parsed.route));
      return;
    }
    const pathOf = this.pathOf(model);
    const path = this.pathSql(builder, pathOf);
    const subjects = parsed.subjects.map((s) => this.subjectTriple(s));
    const listing = this.listing(model);
    const plan = rbacRoutePlan(listing, parsed, pathOf.type);
    whereRbacSql(builder, this.routeSql(plan, { graph: listing.roles, subjects, path, now: this.now(), contains: (haystack, needle) => rbacDialectOf(this.driverOf(builder)).contains(haystack, needle) }));
  }

  /**
   * A route plan as one fragment under `whenFound` (the evaluator reads the row's path before anything
   * else): the AND of its needs, each a constant from the config roles or an `EXISTS` over the subjects'
   * assignments on the path.
   */
  routeSql(plan: RbacRoutePlan, at: RbacRouteSqlContext): RbacSql {
    if (!plan.applies) return at.path.whenFound(FALSE_SQL);
    const parts = plan.needs.map((n) => this.routeNeedSql(n, at)).filter((p) => p !== TRUE_SQL);
    return at.path.whenFound(parts.includes(FALSE_SQL) ? FALSE_SQL : andSql(...parts));
  }

  /** `TRUE_SQL` when a config role meets it, `FALSE_SQL` when no assignment can. */
  routeNeedSql(need: RbacRouteNeed, at: RbacRouteSqlContext): RbacSql {
    if (need.config) return TRUE_SQL;
    const alias = need.what === 'tag' ? this.tagAlias : this.alias;
    const role = (roles: readonly string[]): RbacSql | undefined => {
      const scopes = rbacRoleScopes(at.graph, roles);
      return isEmptyRoleScopes(scopes) ? undefined : this.roleIn(scopes, alias);
    };
    const kinds: RbacSql[] = [];
    const direct = role(need.direct);
    // Stored as ',a,b,' and a tag holds no ',': a substring test is exact, where LIKE would also match '_' and, on SQLite, other letter cases.
    if (direct) kinds.push(need.storedTag === undefined ? direct : andSql(direct, at.contains(rsql`${ident(alias, 'tags')}`, rsql`${`,${need.storedTag},`}`)));
    const implied = role(need.implied);
    if (implied) kinds.push(implied);
    const below = role(need.impliedBelow);
    if (below) kinds.push(andSql(below, notSql(at.path.atNode(alias, 0))));
    if (kinds.length === 0 || at.subjects.length === 0) return FALSE_SQL;
    const where = andSql(this.subjectIn(at.subjects, alias), this.live(at.now, alias), this.onPath(at.path, alias), orSql(...kinds), ...(need.madeAt ? [inList(rsql`${ident(alias, 'scope_type')}`, need.madeAt)] : []));
    return rsql`EXISTS (SELECT 1 FROM ${ident(this.table)} ${ident(alias)} WHERE ${where})`;
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

  /** L1's parser: anything but the exact v1 shape (another `v`, unknown keys, non-canonical order) is refused. */
  protected parseArgs(args: unknown): RbacAssignmentArgs {
    try {
      return parseRbacAssignmentArgs(args);
    } catch (e) {
      throw new AuthzConfigError(e instanceof Error ? e.message : `${this.op}: malformed args`, { cause: e });
    }
  }

  /** L1b's parser of args v2: anything but the exact canonical shape is refused. */
  protected parseRouteArgs(args: unknown): RbacAssignmentArgsV2 {
    try {
      return parseRbacListArgs(RBAC_ASSIGNMENT_OP, args);
    } catch (e) {
      throw new AuthzConfigError(e instanceof Error ? e.message : `${this.op}: malformed args`, { cause: e });
    }
  }
}

/**
 * `native:rbac.threshold` v1 (model/rules/args.ts) → the rows where the named bound threshold rule denies the
 * permission, after restrict and cap with every rule of the args (design §6.1.2 step 8, §12.4): `RbacRulesSql`.
 * `{ db: true }` and `dbRules` are refused until the next L4b task. Postgres needs JIT off for these terms
 * (`RbacListCompiler`).
 */
@Injectable(OrmNativeCompiler)
@Inject(Container)
export class RbacThresholdOrmCompiler extends RbacListCompiler {
  readonly op = RBAC_THRESHOLD_OP;

  constructor(container: IContainer) {
    super(container);
  }

  /** Reads the principal only from the args, never from `_principal`. */
  compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, _principal: Principal): void {
    const parsed = this.parseThresholdArgs(args);
    const target = parsed.threshold;
    if (!('rule' in target)) throw new AuthzConfigError(`${this.where(this.pathOf(model).type)}: the DB threshold rules ({ db: true }) are not compiled to SQL yet (the next L4b task); refused rather than listing rows they deny`);
    whereRbacSql(builder, this.rulesSql(builder, model, parsed).threshold(target.rule));
  }

  /** L1b's parser: anything but the exact canonical shape is refused. */
  protected parseThresholdArgs(args: unknown): RbacThresholdArgs {
    try {
      return parseRbacListArgs(RBAC_THRESHOLD_OP, args);
    } catch (e) {
      throw new AuthzConfigError(e instanceof Error ? e.message : `${this.op}: malformed args`, { cause: e });
    }
  }
}
