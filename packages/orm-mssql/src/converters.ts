/* eslint-disable prettier/prettier */
import { DatetimeValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class MsSqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime | string) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    // UTC, like a Date: mssql reads DATETIME values back as UTC
    if (value instanceof DateTime) {
      return value.toUTC().toISO({ includeOffset: false });
    }

    if (typeof value === 'string') {
      return value;
    }

    return null;
  }

  public fromDB(value: Date) {
    if (!value) {
      return null;
    }

    return DateTime.fromJSDate(value);
  }
}
