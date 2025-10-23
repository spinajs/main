import { Connection, Primary, Model, Query } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Relation } from '../../../src/relation-objects.js';
import { Model1 } from './Model1.js';
import { RawModel } from './RawModel.js';

@Connection('sqlite')
@Model('QueryRelationModel')
// @ts-ignore
export class QueryRelationModel extends ModelBase {
  @Primary()
  public Id: number;

  public Property2: string;

  @Query<QueryRelationModel, RawModel>(
    (data: QueryRelationModel[]) => {
      return Promise.resolve(RawModel.query().whereIn(
        'Id',
        data.map((x) => x.Id),
      ) as any);
    },
    (_owner, data) => {
      return data;
    },
  )
  public Many: Relation<Model1, RawModel>;
}
