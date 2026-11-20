import { DateTime } from 'luxon';
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

  public fromDB(value: unknown): DateTime | null {
    if (typeof value !== 'string' || value === '') {
      return super.fromDB(value);
    }

    let dt = DateTime.fromISO(value, { zone: this.Zone });
    if (!dt.isValid) {
      dt = DateTime.fromSQL(value, { zone: this.Zone });
    }

    return dt.isValid ? dt.toUTC() : null;
  }

  protected write(dt: DateTime): string {
    return super.write(dt.setZone(this.Zone));
  }
}
