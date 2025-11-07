import { BooleanValueConverter, DatetimeValueConverter, IColumnDescriptor, IDehydrateOptions, IValueConverter, ModelBase, TimeValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { TimeSpan } from '@spinajs/util';

const DATE_NUMERICAL_TYPES = ['int', 'integer', 'float', 'double', 'decimal', 'bigint', 'smallint', 'tinyint', 'mediumint'];

export class SqlSetConverter implements IValueConverter {
  public toDB(value: unknown) {
    if (value && Array.isArray(value)) {
      return value.join(',');
    }
    return value;
  }

  public fromDB(value: string | string[]) {
    if (typeof value === 'string') {
      return value.split(',');
    }
    return value ?? [value];
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

export class SqlTimeValueConverter extends TimeValueConverter {
  /**
   * Converts TimeSpan to MySQL TIME format (HH:MM:SS or HHH:MM:SS for values > 24 hours)
   * MySQL TIME can range from '-838:59:59' to '838:59:59'
   * @param value - TimeSpan object or string/number that can be parsed as TimeSpan
   * @returns MySQL TIME format string or null
   */
  public toDB(value: TimeSpan | string | number | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    let timeSpan: TimeSpan;

    // Convert to TimeSpan if not already
    if (value instanceof TimeSpan) {
      timeSpan = value;
    } else {
      const parsed = TimeSpan.parse(value);
      if (!parsed) {
        return null;
      }
      timeSpan = parsed;
    }

    // MySQL TIME format supports hours beyond 24 (up to 838:59:59)
    const totalHours = Math.floor(timeSpan.totalHours);
    const minutes = timeSpan.minutes;
    const seconds = timeSpan.seconds;
    
    const sign = timeSpan.totalMilliseconds < 0 ? '-' : '';
    const absHours = Math.abs(totalHours);
    
    // Format as HH:MM:SS or HHH:MM:SS (MySQL TIME allows hours > 99)
    const hoursStr = String(absHours).padStart(2, '0');
    const minutesStr = String(Math.abs(minutes)).padStart(2, '0');
    const secondsStr = String(Math.abs(seconds)).padStart(2, '0');
    
    return `${sign}${hoursStr}:${minutesStr}:${secondsStr}`;
  }

  /**
   * Converts MySQL TIME format to TimeSpan object
   * Supports formats: HH:MM:SS, HHH:MM:SS, HH:MM:SS.ffffff (with microseconds)
   * @param value - MySQL TIME string (e.g., "15:30:00", "838:59:59", "-12:30:45")
   * @returns TimeSpan object or null
   */
  public fromDB(value: string | TimeSpan | null | undefined): TimeSpan | null {
    if (value === null || value === undefined) {
      return null;
    }

    // If already a TimeSpan, return as-is
    if (value instanceof TimeSpan) {
      return value;
    }

    // Parse MySQL TIME format: [H]HH:MM:SS[.ffffff]
    // Can have negative sign and hours can be > 24
    const timeRegex = /^(-)?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
    const match = String(value).match(timeRegex);

    if (!match) {
      // Try parsing as standard TimeSpan string
      return TimeSpan.parse(value);
    }

    const isNegative = match[1] === '-';
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3], 10);
    const seconds = parseInt(match[4], 10);
    const microseconds = match[5] ? parseInt(match[5].padEnd(6, '0'), 10) : 0;
    
    // Convert microseconds to milliseconds (MySQL stores up to 6 decimal places)
    const milliseconds = Math.floor(microseconds / 1000);

    // Calculate total milliseconds
    let totalMillis = hours * TimeSpan.MILLIS_PER_HOUR +
                      minutes * TimeSpan.MILLIS_PER_MINUTE +
                      seconds * TimeSpan.MILLIS_PER_SECOND +
                      milliseconds;

    if (isNegative) {
      totalMillis = -totalMillis;
    }

    return new TimeSpan(totalMillis);
  }
}

export class SqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime, _model: ModelBase<unknown>, column: IColumnDescriptor, _options?: any, dehydrateOptions?: IDehydrateOptions): string | number | null {
    if (value === null) {
      return null;
    }

    if (value === undefined) {
      return '1970-01-01 00:00:00';
    }

    let dt: DateTime = null;
    if (typeof value === 'string') {
      dt = DateTime.fromISO(value);
    } else {
      dt = DateTime.isDateTime(value) ? value : DateTime.fromJSDate(value);
    }


    if (dehydrateOptions && dehydrateOptions.dateTimeFormat) {
      switch (dehydrateOptions.dateTimeFormat) {
        case 'iso':
          return dt.toISO();
        case 'sql':
          return dt.toSQL({ includeOffset: false });
        case 'unix':
          return dt.toUnixInteger() ?? 0;
      }
    }


    if (column) {
      if (DATE_NUMERICAL_TYPES.includes(column.Type)) {
        return dt.toUnixInteger() ?? 0;
      }
    }

    return dt.toSQL({ includeOffset: false });
  }

  public fromDB(value: string | DateTime | Date | number) {
    if (!value) {
      return null;
    }

    if (DateTime.isDateTime(value)) {
      return value;
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
