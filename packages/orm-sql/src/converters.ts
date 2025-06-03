import { BooleanValueConverter, DatetimeValueConverter, IColumnDescriptor, IDehydrateOptions, IValueConverter, ModelBase } from '@spinajs/orm';
import { DateTime } from 'luxon';

const DATE_NUMERICAL_TYPES = ['int', 'integer', 'float', 'double', 'decimal', 'bigint', 'smallint', 'tinyint', 'mediumint'];

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
