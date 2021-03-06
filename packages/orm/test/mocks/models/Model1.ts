/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, Archived, CreatedAt, UpdatedAt, SoftDelete, BelongsTo, DateTime } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { SingleRelation } from './../../../src/relations';
import { Model4 } from './Model4';
import { DateTime as lDateTime } from 'luxon';

@Connection('sqlite')
@Model('TestTable1')
export class Model1 extends ModelBase {
  @Primary()
  public Id: number;

  @Archived()
  @DateTime()
  public ArchivedAt: lDateTime;

  @CreatedAt()
  public CreatedAt: lDateTime;

  @UpdatedAt()
  public UpdatedAt: lDateTime;

  @SoftDelete()
  public DeletedAt: lDateTime;

  @BelongsTo(Model4, 'OwnerId')
  public Owner: SingleRelation<Model4>;

  public Bar: string;
}
