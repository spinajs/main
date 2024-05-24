import { BooleanValueConverter, DatetimeValueConverter, IValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class SqlSetConverter implements IValueConverter {
  public toDB(value: unknown[]) {
    if (value) {
      return value.join(',');
    }
    return '';
  }

  public fromDB(value: string | string[]) {
    if (typeof value === 'string') {
      return value.split(',');
    }
    return value ?? [];
  }
}

export class SqlBooleanValueConverter implements BooleanValueConverter {
  toDB(value: any) {
    return value ? 1 : 0;
  }
  fromDB(value: any) {
    return value === 1 || value === true || value === '1';
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

  public fromDB(value: string | DateTime | Date | number) {
    if (!value) {
      return null;
    }

    // we do this checks, becose at creating models from data
    // we call hydrators, and hydrators checks for converters.
    if (value instanceof DateTime) {
      return value;
    }

    if (value instanceof Date) {
      return DateTime.fromJSDate(value);
    }

    // assume that we have unix timestamp
    if (Number.isInteger(value)) {
      return DateTime.fromSeconds(value as number);
    }

    return DateTime.fromSQL(value as string);
  }
}
