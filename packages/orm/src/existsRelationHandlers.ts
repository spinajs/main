/* eslint-disable prettier/prettier */
import { Injectable } from '@spinajs/di';
import { Lazy } from '@spinajs/util';
import { IRelationDescriptor, IModelStatic, ISelectQueryBuilder, RelationType } from './interfaces.js';
import { RawQuery } from './builders.js';
import type { WhereBuilder } from './builders.js';
import { WhereFunction } from './types.js';

/**
 * Strategy that builds the EXISTS / NOT EXISTS clause for one relation type.
 *
 * Resolved via `Array.ofType(ExistsRelationHandler)` and dispatched by `rel.Type` from
 * `WhereBuilder.buildExistsClause`. Implementations either:
 *  - mutate the outer builder directly and return `undefined` (eg. {@link RelationType.One}
 *    adds `WHERE FK IS NOT NULL` plus a right-join, no EXISTS sub-query is generated), or
 *  - return a correlated sub-query that the caller wraps in EXISTS/NOT EXISTS.
 */
export abstract class ExistsRelationHandler {
  public abstract get Type(): RelationType;

  public abstract apply<R>(builder: WhereBuilder<any>, rel: IRelationDescriptor, relationName: string, callback?: WhereFunction<R>): ISelectQueryBuilder | undefined;
}

/**
 * Resolves the correlated source primary key column reference, eg. `` `users`.`Id` ``.
 * Falls back to the source descriptor's `TableName` when neither the builder nor its parent
 * has an alias set, matching the legacy behaviour of `whereExist` / `whereNotExists`.
 */
function sourcePKeyRef(builder: WhereBuilder<any>, tDesc: { TableName: string; PrimaryKey: string[] }): string {
  return sourceColumnRef(builder, tDesc, tDesc.PrimaryKey[0]);
}

/**
 * Resolves an arbitrary correlated column on the source side, eg. `` `entries`.`group_id` ``.
 *
 * {@link RelationType.One} correlates on the source's FOREIGN key rather than its primary
 * key, so it cannot reuse {@link sourcePKeyRef}. Both share the alias resolution: the
 * builder's alias, its parent's, or the source table name.
 */
function sourceColumnRef(builder: WhereBuilder<any>, tDesc: { TableName: string }, column: string): string {
  const sourceAlias = builder.TableAlias ?? tDesc.TableName;
  return `\`${sourceAlias}\`.\`${column}\``;
}

@Injectable(ExistsRelationHandler)
export class OneExistsRelationHandler extends ExistsRelationHandler {
  public get Type(): RelationType {
    return RelationType.One;
  }

  public apply<R>(builder: WhereBuilder<any>, rel: IRelationDescriptor, _relationName: string, callback?: WhereFunction<R>): ISelectQueryBuilder | undefined {
    builder.whereNotNull(rel.ForeignKey);

    // A belongsTo with a non-null FK always has its parent row, so an unconditional check
    // needs no sub-query at all.
    if (!callback) {
      return undefined;
    }

    /**
     * Correlated EXISTS, NOT a join.
     *
     * This ran as `builder.rightJoin(...)` on the OUTER builder, which only ever worked on
     * selects: `UpdateQueryBuilder` mixes in `WhereBuilder` alone and `DeleteQueryBuilder`
     * adds only `LimitBuilder`, so neither defines `rightJoin`. The rbac middleware runs
     * `afterQueryCreation` on all three builder types, so any model reaching ownership
     * through a belongsTo threw a TypeError the moment it was updated or deleted, and had
     * to hand-roll the correlation in raw SQL instead.
     *
     * EXISTS is also the semantics the method name promises: the join form leaked the
     * joined table's columns into the outer result and turned an existence test into a
     * row-multiplying join.
     */
    const tDesc = (builder.Model as unknown as IModelStatic).getModelDescriptor();
    const alias = `${rel.TargetModel.getModelDescriptor().TableName}_exists`;

    const relQuery = rel.TargetModel.query().setAlias(alias);

    // lazy, so the outer alias is resolved at compile time - it may be assigned after this
    // handler runs. Both sides stay alias-qualified so a callback that joins further tables
    // cannot make the correlation column ambiguous.
    relQuery.where(
      Lazy.oF(function () {
        relQuery.where(new RawQuery(`\`${alias}\`.\`${rel.PrimaryKey}\` = ${sourceColumnRef(builder, tDesc, rel.ForeignKey)}`));
      }),
    );

    callback.apply(relQuery);

    return relQuery;
  }
}

@Injectable(ExistsRelationHandler)
export class ManyExistsRelationHandler extends ExistsRelationHandler {
  public get Type(): RelationType {
    return RelationType.Many;
  }

  public apply<R>(builder: WhereBuilder<any>, rel: IRelationDescriptor, _relationName: string, callback?: WhereFunction<R>): ISelectQueryBuilder {
    const tDesc = (builder.Model as unknown as IModelStatic).getModelDescriptor();
    const tableName = rel.TargetModel.getModelDescriptor().TableName;

    // set alias to avoid conflicts in case of multiple relations to same model and to make
    // sure that relation query is correct even if source query has alias
    const relQuery = rel.TargetModel.query().setAlias(`${tableName}_exists`);
    relQuery.where(
      Lazy.oF(function () {
        relQuery.where(new RawQuery(`${rel.ForeignKey} = ${sourcePKeyRef(builder, tDesc)}`));
      }),
    );

    if (callback) {
      callback.apply(relQuery);
    }

    return relQuery;
  }
}

@Injectable(ExistsRelationHandler)
export class ManyToManyExistsRelationHandler extends ExistsRelationHandler {
  public get Type(): RelationType {
    return RelationType.ManyToMany;
  }

  public apply<R>(builder: WhereBuilder<any>, rel: IRelationDescriptor, _relationName: string, callback?: WhereFunction<R>): ISelectQueryBuilder {
    const tDesc = (builder.Model as unknown as IModelStatic).getModelDescriptor();
    const junctionModel = rel.JunctionModel as unknown as IModelStatic;
    const junctionTableName = junctionModel.getModelDescriptor().TableName;

    const relQuery = junctionModel.query().setAlias(`${junctionTableName}_exists`);
    relQuery.where(
      Lazy.oF(function () {
        relQuery.where(new RawQuery(`${rel.JunctionModelSourceModelFKey_Name} = ${sourcePKeyRef(builder, tDesc)}`));
      }),
    );

    if (callback) {
      relQuery.rightJoin({
        joinModel: rel.TargetModel,
        joinTableForeignKey: rel.PrimaryKey,
        sourceTablePrimaryKey: rel.JunctionModelTargetModelFKey_Name,
        callback: callback,
      });
    }

    return relQuery;
  }
}
