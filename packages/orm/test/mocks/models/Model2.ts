import { Connection, Primary, Model, Archived, CreatedAt, UpdatedAt, SoftDelete } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { DateTime } from 'luxon';

@Connection('SampleConnection1')
@Model('TestTable2')
// @ts-ignore
export class Model2 extends ModelBase {
  @Primary()
  public Id: number;

  @Archived()
  public ArchivedAt: DateTime;

  @CreatedAt()
  public CreatedAt: DateTime;

  @UpdatedAt()
  public UpdatedAt: DateTime;

  @SoftDelete()
  public DeletedAt: DateTime;
}
