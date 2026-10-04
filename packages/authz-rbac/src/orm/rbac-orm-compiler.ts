import { AuthzClock, AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { Container, Inject, Injectable } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { IdentifierQuoter, RawQuery } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';
import { Lazy } from '@spinajs/util';

import { RBAC_ASSIGNMENT_OP } from '../contracts.js';
import { parseRbacAssignmentArgs } from '../model/native.js';
import type { RbacArgsSubject, RbacAssignmentArgs } from '../model/native.js';
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

/** What the building blocks need to write SQL about one `authz_assignment` alias. */
export interface RbacSqlContext {
  readonly quoter: IdentifierQuoter;
  readonly path: RbacScopePath;
  /** Alias of the `authz_assignment` row the block constrains. */
  readonly alias: string;
  /** Quoted alias (or name) of the scoped outer table, read when the SQL is built. */
  readonly outer: string;
  readonly now: Date;
}

interface BuilderLinks {
  readonly Driver?: OrmDriver;
  readonly Table?: string;
  readonly TableAlias?: string;
  readonly Parent?: BuilderLinks;
}

/**
 * `native:rbac.assignment` (args: model/native.ts) → the `EXISTS` over `authz_assignment` of §6.1.3:
 * `subjectIn AND roleIn AND live AND onPath`. The blocks are separate methods so the rule
 * compilation of §12.4 can reuse and wrap them.
 */
@Injectable(OrmNativeCompiler)
@Inject(Container)
export class RbacOrmCompiler extends OrmNativeCompiler {
  readonly op = RBAC_ASSIGNMENT_OP;

  protected readonly table: string = AUTHZ_ASSIGNMENT_TABLE;
  // Distinct from usual table aliases: an outer table with the same alias would be shadowed.
  protected readonly alias: string = 'authz_a';

  constructor(protected readonly container: IContainer) {
    super();
  }

  compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, _principal: Principal): void {
    const parsed = this.parseArgs(args);
    const path = this.pathOf(model);
    // Mapped here, not in the lazy SQL part, so a bad subject throws from compile().
    const subjects = parsed.subjects.map((s) => this.subjectTriple(s));
    const roles = parsed.roles;

    const term: RbacAssignmentTerm | null = roles.length === 0 || subjects.length === 0 ? null : { subjects, roles: this.roleScopes(model, roles) };
    if (!term || isEmptyRoleScopes(term.roles)) {
      builder.where(new RawQuery('1 = 0'));
      return;
    }

    this.assignmentExists(builder, term, path, this.now());
  }

  /** Adds `EXISTS (SELECT … FROM authz_assignment <alias> WHERE …)` to `builder`, correlated with its table. */
  assignmentExists(builder: IWhereBuilder<unknown>, term: RbacAssignmentTerm, path: RbacScopePath, now: Date, alias: string = this.alias): void {
    const root = this.rootOf(builder);
    const quoter = root.Driver!.Container.resolve(IdentifierQuoter);
    const sub = root.Driver!.select().from(this.table, alias).correlateWith(builder);
    const self = this;

    // Lazy, like the ORM's own correlated EXISTS: the outer alias may be set or
    // changed (populate, clone) after this runs, so it is read at SQL build time.
    sub.where(
      Lazy.oF(function (this: SelectQueryBuilder) {
        const outer = self.outerRef((this.CorrelationSource as BuilderLinks | undefined) ?? (builder as BuilderLinks), root.Table, quoter, alias);
        const ctx: RbacSqlContext = { quoter, path, alias, outer, now };
        this.where(function () {
          self.assignmentWhere(this, term, ctx);
        });
      }),
    );

    builder.whereExist(sub);
  }

  protected assignmentWhere(w: IWhereBuilder<unknown>, term: RbacAssignmentTerm, ctx: RbacSqlContext): void {
    this.subjectIn(w, term.subjects);
    this.roleIn(w, term.roles);
    this.live(w, ctx.now);
    this.onPath(w, ctx);
  }

  /** OR of `(subject_type, subject_id, subject_role)` equality triples; row-value `IN` is not portable. */
  subjectIn(w: IWhereBuilder<unknown>, subjects: readonly RbacSubjectTriple[]): void {
    w.where(function () {
      for (const s of subjects) {
        this.orWhere(function () {
          this.where('subject_type', s.type).where('subject_id', s.id).where('subject_role', s.role);
        });
      }
    });
  }

  /** `role IN (:anyScope) OR (role = :r AND scope_type IN (:scopeTypes)) OR …`; the caller refuses empty roles. */
  roleIn(w: IWhereBuilder<unknown>, roles: RbacRoleScopes): void {
    w.where(function () {
      if (roles.anyScope.length > 0) {
        this.orWhere(function () {
          this.whereIn('role', [...roles.anyScope]);
        });
      }
      for (const r of roles.scoped) {
        this.orWhere(function () {
          this.where('role', r.role).whereIn('scope_type', [...r.scopeTypes]);
        });
      }
    });
  }

  live(w: IWhereBuilder<unknown>, now: Date): void {
    w.where(function () {
      this.whereNull('expires_at').orWhere('expires_at', '>', now);
    });
  }

  /** `$global`, the type-only scope of the row's type, the row itself, then every scope column of the path. */
  onPath(w: IWhereBuilder<unknown>, ctx: RbacSqlContext): void {
    const self = this;
    w.where(function () {
      this.where('scope_type', GLOBAL.type);
      // A type-only scope reaches the rows of its own type only (scopeMatcher in model/native.ts).
      this.orWhere(function () {
        this.where('scope_type', ctx.path.type).where('scope_id', '');
      });
      this.orWhere(function () {
        self.atScope(this, ctx, ctx.path.type, ctx.path.idColumn);
      });
      for (const s of ctx.path.scopes) {
        this.orWhere(function () {
          self.atScope(this, ctx, s.scopeType, s.column);
        });
      }
    });
  }

  /** As the assignment store writes subjects: a principal `(type, id, '')`, a set `(scope.type, scope.id ?? '', role)`. */
  protected subjectTriple(s: RbacArgsSubject): RbacSubjectTriple {
    if (!('set' in s)) return { type: s.type, id: s.id, role: '' };
    const { role, scope } = s.set;
    if (role === '') throw new AuthzConfigError(`${this.op}: a subject set at ${scope.type}:${scope.id ?? ''} has an empty role; it would match the principal`);
    return { type: scope.type, id: scope.type === GLOBAL.type ? '' : scope.id ?? '', role };
  }

  /**
   * `scope_type = :type AND scope_id <> '' AND scope_id = <outer>.<column>`, the row value compared
   * as text. An empty column value must not reach the type-only scope `(type, '')`.
   */
  protected atScope(w: IWhereBuilder<unknown>, ctx: RbacSqlContext, scopeType: string, column: string): void {
    const scopeId = `${ctx.quoter.quote(ctx.alias)}.${ctx.quoter.quote('scope_id')}`;
    w.where('scope_type', scopeType)
      .where('scope_id', '<>', '')
      .where(new RawQuery(`${scopeId} = ${this.textOf(`${ctx.outer}.${ctx.quoter.quote(column)}`, ctx.quoter)}`));
  }

  /**
   * `scope_id` is varchar while row columns may be integers, and postgres will not compare the two.
   * No length: postgres and MySQL cut a cast value to it silently, and a cut id would equal another one.
   */
  protected textOf(expr: string, quoter: IdentifierQuoter): string {
    const quoted = quoter.quote('x');
    // MySQL's CAST takes CHAR, not VARCHAR or TEXT; SQLite reads CHAR as text too.
    if (quoted === '`x`') return `CAST(${expr} AS CHAR)`;
    // MSSQL reads a bare VARCHAR as varchar(30).
    if (quoted === '[x]') return `CAST(${expr} AS NVARCHAR(4000))`;
    return `CAST(${expr} AS TEXT)`;
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
      throw new AuthzConfigError(`${this.op}: no RbacScopePathSource is registered; authz-orm provides it from @AccessResource and @ScopeColumn`);
    }

    const path = this.container.resolve(RbacScopePathSource).path(model);
    if (!path) {
      throw new AuthzConfigError(`${this.op}: model ${model.name} has no RBAC scope path (is it an @AccessResource?)`);
    }

    return path;
  }

  /** The query a (possibly nested) where builder belongs to: it owns the driver and the table. */
  protected rootOf(builder: IWhereBuilder<unknown>): BuilderLinks {
    for (let b: BuilderLinks | undefined = builder as BuilderLinks; b; b = b.Parent) {
      if (b.Driver) return b;
    }
    throw new AuthzConfigError(`${this.op}: the where builder is not attached to a query`);
  }

  protected outerRef(source: BuilderLinks, table: string | undefined, quoter: IdentifierQuoter, alias: string): string {
    const name = source.TableAlias ?? table;
    if (!name) throw new AuthzConfigError(`${this.op}: the scoped query has no table`);
    if (name === alias) throw new AuthzConfigError(`${this.op}: the scoped query uses the alias "${alias}", which the authz_assignment sub-query needs`);
    return source.TableAlias ? quoter.quote(name) : quoter.quoteQualified(name);
  }
}
