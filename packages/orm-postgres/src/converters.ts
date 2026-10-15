/* eslint-disable @typescript-eslint/no-explicit-any */
import { DatetimeValueConverter, IColumnDescriptor, IDehydrateOptions, JsonValueConverter, ModelBase } from '@spinajs/orm';
import { DateTime } from 'luxon';

const NUMERIC_TYPES = ['int', 'integer', 'float', 'double', 'decimal', 'bigint', 'smallint', 'tinyint', 'mediumint', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8'];

/**
 * Instants go to the server as UTC ISO strings and come back as UTC DateTimes, so neither the
 * process zone nor the session TimeZone moves a stored instant. `dehydrate()` (API output) keeps
 * the formats of the shared SQL converter.
 */
export class PostgresDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: Date | DateTime | string, _model: ModelBase<unknown>, column: IColumnDescriptor, _options?: any, dehydrateOptions?: IDehydrateOptions): string | number | null | undefined {
    // undefined stays undefined: the insert then writes DEFAULT (e.g. CURRENT_TIMESTAMP) instead of NULL
    if (value === null || value === undefined) {
      return value;
    }

    const dt = typeof value === 'string' ? DateTime.fromISO(value, { setZone: true }) : DateTime.isDateTime(value) ? value : DateTime.fromJSDate(value as Date);

    if (dehydrateOptions) {
      switch (dehydrateOptions.dateTimeFormat) {
        case 'iso':
          return dt.toISO();
        case 'unix':
          return dt.toUnixInteger() ?? 0;
        case 'sql':
          return dt.toSQL({ includeOffset: false });
      }
    }

    if (column && NUMERIC_TYPES.includes(column.Type)) {
      return dt.toUnixInteger();
    }

    if (dehydrateOptions) {
      return dt.toSQL({ includeOffset: false });
    }

    // a DATE is a calendar day in the value's own zone, not an instant
    if (column?.Type === 'date') {
      return dt.toISODate();
    }

    return dt.toUTC().toISO();
  }

  public fromDB(value: string | DateTime | Date | number): any {
    if (value === null || value === undefined || (value as any) === '') {
      return null;
    }
    // model construction runs assigned values through here too; converting the zone would move a DATE's day
    if (DateTime.isDateTime(value)) {
      return value;
    }
    if (value instanceof Date) {
      return DateTime.fromJSDate(value, { zone: 'utc' });
    }
    if (typeof value === 'number') {
      return DateTime.fromSeconds(value, { zone: 'utc' });
    }
    // text without an offset (a raw query, a legacy TIMESTAMP read without the type parser) is UTC
    const iso = DateTime.fromISO(value as string, { zone: 'utc' });
    return iso.isValid ? iso : DateTime.fromSQL(value as string, { zone: 'utc' });
  }
}

/** node-postgres already parses json/jsonb; a string here is either a JSON string value or JSON text from a TEXT column. */
export class PostgresJsonValueConverter extends JsonValueConverter {
  public fromDB(value: any): any {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
