/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, Archived, CreatedAt, UpdatedAt, SoftDelete, BelongsTo, DateTime } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Model4 } from './Model4.js';
import { DateTime as lDateTime } from 'luxon';
import { SingleRelation } from '../../../src/relation-objects.js';

@Connection('sqlite')
@Model('TestTable1')
export class Model1 extends ModelBase<Model1> {
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
