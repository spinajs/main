import { DeleteQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

/** The builders a relation list's sync() removes its orphans with. */
export type SyncStatement = UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>;

export const isUpdateOrDelete = (query: QueryBuilder): query is SyncStatement => query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder;
