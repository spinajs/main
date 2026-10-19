/* eslint-disable prettier/prettier */
import { DatetimeValueConverter, IColumnDescriptor, ModelBase } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

export class MsSqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime | string, _model?: ModelBase<unknown>, column?: IColumnDescriptor) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof DateTime) {
      return value.toISO({ includeOffset: false });
    }

    if (typeof value === 'string' && value !== '') {
      let dt = DateTime.fromISO(value);
      if (!dt.isValid) {
        dt = DateTime.fromSQL(value);
      }
      if (!dt.isValid) {
        throw new InvalidArgument(`column ${column?.Name}: "${value}" is not an ISO 8601 or SQL datetime`);
      }
      return dt.toISO({ includeOffset: false });
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
