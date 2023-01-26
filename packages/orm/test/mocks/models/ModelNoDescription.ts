import { ModelBase } from '../../../src/model.js';
import { DateTime } from 'luxon';

export class ModelNoDescription extends ModelBase {
  public Id: number;

  public ArchivedAt: DateTime;

  public CreatedAt: DateTime;

  public UpdatedAt: DateTime;

  public DeletedAt: DateTime;
}
