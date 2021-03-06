/* eslint-disable prettier/prettier */
import { DatetimeValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class MsSqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof DateTime) {
      return value.toISO({ includeOffset: false });
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
