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
function sourcePKeyRef(builder: WhereBuilder<any>, tDesc: { TableName: string; PrimaryKey: string }): string {
  const sourceAlias = builder.TableAlias ?? tDesc.TableName;
  return `\`${sourceAlias}\`.\`${tDesc.PrimaryKey}\``;
}

@Injectable(ExistsRelationHandler)
export class OneExistsRelationHandler extends ExistsRelationHandler {
  public get Type(): RelationType {
    return RelationType.One;
  }

  public apply<R>(builder: WhereBuilder<any>, rel: IRelationDescriptor, relationName: string, callback?: WhereFunction<R>): undefined {
    builder.whereNotNull(rel.ForeignKey);

    // simply use right join for condition check
    if (callback) {
      // TODO: cast fix
      (builder as any).rightJoin(rel.TargetModel, callback.bind(relationName));
    }
    return undefined;
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
