import type { ResourceType } from '@spinajs/authz';
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
 * Adds the condition of one PlanTerm op over the row to a where-group; the renderer ORs, negates and ANDs
 * the groups (design §6.2). It adds at least one predicate: a term that matches no row adds `where(false)`.
 */
export abstract class PlanTermCompiler {
  abstract readonly op: string;
  abstract apply(args: unknown, where: IWhereBuilder<unknown>, row: PlanRow): void;
}
