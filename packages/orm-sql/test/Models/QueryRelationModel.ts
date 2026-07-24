import { Connection, ModelBase, Model, Primary, Query, Relation } from '@spinajs/orm';
import { RelationModel4 } from './RelationModel4.js';

/**
 * A model carrying a `@Query` relation. `QueryRelation` is the one relation kind whose
 * `compile()` had no idempotency guard, so it is what makes `toDB()` observably
 * non-idempotent ( B19 ).
 */
@Connection('sqlite')
@Model('QueryRelationTable')
export class QueryRelationModel extends ModelBase {
  @Primary()
  public Id: number;

  public QueryRelationProperty: string;

  @Query<QueryRelationModel, RelationModel4>(
    (data: QueryRelationModel[]) =>
      RelationModel4.where(
        'Id',
        'in',
        data.map((x) => x.Id),
      ) as any,
    (_owner, data) => data,
  )
  public Many: Relation<RelationModel4, QueryRelationModel>;
}
