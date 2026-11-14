import { DateTime } from 'luxon';
import { IDateTimeConverterOptions } from '@spinajs/orm';
import { SqlDatetimeValueConverter } from '@spinajs/orm-sql';

/**
 * Writes an instant as the wall clock of the connection's session zone, and reads text without an offset in that
 * zone. A Date from mysql2 already carries the instant: the pool parses it in the same zone.
 */
export class MySqlDatetimeValueConverter extends SqlDatetimeValueConverter {
  /**
   * @param Zone - luxon zone of the session wall clock, eg. `utc`, `system` or `UTC+02:00`
   */
  constructor(public readonly Zone: string = 'utc') {
    super();
  }

  public fromDB(value: unknown, raw?: unknown, options?: IDateTimeConverterOptions | null): DateTime | null {
    if (typeof value !== 'string' || value === '') {
      return super.fromDB(value, raw, options);
    }

    let dt = DateTime.fromISO(value, { zone: this.Zone });
    if (!dt.isValid) {
      dt = DateTime.fromSQL(value, { zone: this.Zone });
    }

    // not wall-clock text: mysql2 returns a DECIMAL column as text
    return dt.isValid ? dt.toUTC() : super.fromDB(value, raw, options);
  }

  protected write(dt: DateTime): string {
    return super.write(dt.setZone(this.Zone));
  }
}
