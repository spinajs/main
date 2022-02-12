import { Connection, Primary, Archived, CreatedAt, UpdatedAt, SoftDelete, Model } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { DateTime } from 'luxon';
@Connection('SampleConnectionNotExists')
@Model('test_model')
// @ts-ignore
export class ModelNoConnection extends ModelBase {
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
