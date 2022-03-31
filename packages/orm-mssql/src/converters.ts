/* eslint-disable prettier/prettier */
import { DatetimeValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class MsSqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof DateTime) {
      return value.toISO();
    }

    return null;
  }

  public fromDB(value: string) {
    if (!value) {
      return null;
    }

    return DateTime.fromISO(value);
  }
}
