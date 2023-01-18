import { DatetimeValueConverter, IValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';
export class SqlSetConverter implements IValueConverter {
  public toDB(value: unknown[]) {
    if (value) {
      return value.join(',');
    }
    return '';
  }

  public fromDB(value: string) {
    if (value) {
      return value.split(',');
    }
    return [];
  }
}

export class SqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime) {
    if (value instanceof Date) {
      return DateTime.fromJSDate(value).toSQL({ includeOffset: false });
    }

    if (value instanceof DateTime) {
      return value.toSQL({ includeOffset: false });
    }

    return null;
  }

  public fromDB(value: string) {
    if (!value) {
      return null;
    }

    return DateTime.fromSQL(value);
  }
}
