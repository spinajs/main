import { Connection, Model, ModelBase, Primary, UpdatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** `@UpdatedAt` without `?`: an insert leaves it NULL, so the manifest must record it nullable. */
@Connection('default')
@Model('stamps')
export class Stamp extends ModelBase<Stamp> {
  @Primary()
  public Id: number;

  public Name: string;

  @UpdatedAt()
  public Updated: DateTime;
}
