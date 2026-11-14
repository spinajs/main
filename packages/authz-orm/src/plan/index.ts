import type { AuthorizationModel, ModelListPlan, PermissionDef, Principal, ResourceType } from '@spinajs/authz';
import type { ISelectQueryBuilder, IWhereBuilder, RawQuery, Wrap } from '@spinajs/orm';

// `@spinajs/authz-orm/plan`: a model package imports the contract from here without loading the adapter
// (its migrations, query middlewares and contributor). Nothing below may import at runtime.

export const RELATION_OWNER_OP = 'relation.owner';
export const RELATION_SELF_OP = 'relation.self';
export const RELATION_COLUMN_OP = 'relation.column';

/** The args of relation.owner / relation.self: the row's owner (self) is one of these principals. */
export interface RelationPlanArgs {
  readonly principals: readonly { readonly type: string; readonly id: string }[];
}

/** The args of relation.column: the row's column relation `relation` (`@Relation`) holds one of these principals. */
export interface RelationColumnPlanArgs extends RelationPlanArgs {
  readonly relation: string;
}

/** The row a plan term filters, seen from a where-group of the resource query. */
export interface PlanRow {
  readonly type: ResourceType;
  /** The row's id column cast to text: `whereIn(row.id, ids)` on the group, `outer(row.id)` in a sub-query. */
  readonly id: Wrap;
  /** Columns of the row's relation `name` (owner, self, or a named column relation), when the resource declares one. */
  readonly relation: (name: string) => { readonly column: string; readonly typeColumn?: string } | undefined;
  /** authz_resource_ancestor: resource_type, resource_id, ancestor_type, ancestor_id, depth. */
  readonly ancestorTable: string;
  /** The database's current instant: `where('expires_at', '>', row.now())`. */
  now(): RawQuery;
  /** A query on `table` as `alias`, on the row's connection; `whereExist()` / `whereIn()` correlate it with the group they are called on. */
  from(table: string, alias: string): ISelectQueryBuilder<unknown>;
}

/**
 * What `PlanTermCompiler.renderSql` renders a term against: one table of a row level security policy.
 * Identifiers come quoted and columns qualified with the table; the principal comes from the session
 * settings the authz-orm session middleware sets, never from the term's args.
 */
export interface RlsSqlContext {
  readonly type: ResourceType;
  /** The policy's table, quoted. */
  readonly table: string;
  /** The row's id column as text: `scope_id = ${ctx.id}`. */
  readonly id: string;
  /** The quoted, qualified columns of the row's relation `name` (owner, self, or a named column relation). */
  relation(name: string): { readonly column: string; readonly typeColumn?: string } | undefined;
  /** authz_resource_ancestor, quoted. */
  readonly ancestorTable: string;
  /** A sub-select of the session's subject keys: `subject_key IN (${ctx.subjectKeys})`. */
  readonly subjectKeys: string;
  /** A sub-select of the session's principals as `principal_type, principal_id` rows. */
  readonly principals: string;
  /** The database's current instant. */
  readonly now: string;
  literal(value: string): string;
  ident(name: string): string;
}

/**
 * Adds the condition of one PlanTerm op over the row to a where-group; the renderer ORs, negates and ANDs
 * the groups (design §6.2). It adds at least one predicate: a term that matches no row adds `where(false)`.
 */
export abstract class PlanTermCompiler {
  abstract readonly op: string;
  abstract apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void;
  /**
   * The args of narrower terms of this op whose OR is the term, each standing for one source of access
   * (RBAC: one role). Rows matching the same atoms share one field-set decision (`.withFields()`), so a
   * term over several roles must split here, or rows holding different roles would share one field set.
   */
  atoms?(args: unknown): readonly unknown[];
  /**
   * The term as a Postgres boolean expression for a row level security policy (`authz:rls`): args come from an
   * `RlsPlanSource` (the plan for any principal) and the principal from the session (`ctx.subjectKeys`,
   * `ctx.principals`). Without it, a term is something the database cannot evaluate (AUTHZ020).
   */
  renderSql?(args: unknown, ctx: RlsSqlContext): string;
}

/**
 * A model's list plan for any principal, for row level security (`authz:rls`): the terms of `.accessible()`
 * with what does not depend on the principal filled in (every role that grants the permission, the
 * relation's rewrite) and the principal parts left for `renderSql` to read from the session. A routed
 * model with no source is opaque to the generator.
 */
export abstract class RlsPlanSource {
  /** The `AuthorizationModel.name` it speaks for. */
  abstract readonly model: string;
  /**
   * `model` is the domain's instance named `this.model`.
   * @throws Error naming what the database cannot evaluate; the generator reports it as AUTHZ020
   */
  abstract plan(model: AuthorizationModel, permission: PermissionDef, type: ResourceType): ModelListPlan | Promise<ModelListPlan>;
}

/** RLS: the row's relation columns hold one of the session's principals (`spina.principal`); without a type column, a user. */
export function sessionPrincipalsMatch(ctx: RlsSqlContext, { column, typeColumn }: { readonly column: string; readonly typeColumn?: string }): string {
  if (typeColumn === undefined) return `${column}::text IN (SELECT principal_id FROM (${ctx.principals}) AS sp WHERE principal_type = 'user')`;
  return `(${typeColumn}::text, ${column}::text) IN (SELECT principal_type, principal_id FROM (${ctx.principals}) AS sp)`;
}

/**
 * The subject keys a principal acts as in a model's RLS terms (`ctx.subjectKeys`): the session
 * middleware sets `spina.subject_keys` to the union over the domain's models that have one.
 */
export abstract class RlsSubjectKeys {
  /** The `AuthorizationModel.name` it speaks for. */
  abstract readonly model: string;
  abstract keys(model: AuthorizationModel, principal: Principal): Promise<readonly string[]>;
}
