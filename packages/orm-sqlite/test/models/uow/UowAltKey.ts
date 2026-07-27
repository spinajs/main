/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_alt_target')
export class UowAltTarget extends ModelBase {
  @Primary()
  public Id: number;

  /** The column the relation actually joins on — deliberately not the primary key. */
  public Code: string;

  public Label: string;
}

@Connection('sqlite')
@Model('uow_alt_owner')
export class UowAltOwner extends ModelBase {
  @Primary()
  public Id: number;

  public target_code: string;

  @BelongsTo(UowAltTarget, 'target_code', 'Code')
  public Target: SingleRelation<UowAltTarget>;
}
