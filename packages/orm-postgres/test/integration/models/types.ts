/* eslint-disable @typescript-eslint/no-explicit-any */
import { Bool, Connection, DateTime as DateTimeColumn, Json, Model, ModelBase, Primary, SoftDelete } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('postgres')
@Model('pg_typed')
export class PgTyped extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Data: any;

  @Bool()
  public Flag: boolean;

  public Price: string;

  public Big: string;

  public Kind: string;

  public Payload: Buffer;

  public Ratio: number;
}

@Connection('postgres')
@Model('pg_event')
export class PgEvent extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @DateTimeColumn()
  public At: DateTime;

  @DateTimeColumn()
  public CreatedAt: DateTime;

  @DateTimeColumn()
  public Day: DateTime;
}

@Connection('postgres')
@Model('pg_account')
export class PgAccount extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('postgres')
@Model('pg_setting')
export class PgSetting extends ModelBase {
  @Primary({ generated: 'assigned' })
  public Name: string;

  public Value: string;
}

@Connection('postgres')
@Model('pg_tx_user')
export class PgTxUser extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('postgres')
@Model('pg_soft')
export class PgSoft extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @SoftDelete()
  public DeletedAt: DateTime;
}

@Connection('postgres')
@Model('pg_lease')
export class PgLease extends ModelBase {
  @Primary({ generated: 'assigned' })
  public Name: string;

  public Owner: string | null;

  // not `DateTime | null`: @DateTime() checks the reflected type, and a union reflects as Object
  @DateTimeColumn()
  public LeaseUntil: DateTime;

  public Version: number;
}
