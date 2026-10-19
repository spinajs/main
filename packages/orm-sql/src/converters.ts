import { BooleanValueConverter, DatetimeValueConverter, IColumnDescriptor, IDehydrateOptions, IValueConverter, ModelBase, TimeValueConverter, instantFromDb, toInstant } from '@spinajs/orm';
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
  /**
   * SQL wants 0/1, a dehydrated payload wants the boolean the property declares.
   *
   * Both are `toDB`, and the caller is what tells them apart: an INSERT/UPDATE payload
   * (`ModelToSqlConverter`, `StandardObjectToSqlConverter`) and a WHERE binding (`compilers.ts`,
   * `statements.ts`) all call with FOUR arguments, while `dehydrators.ts` - the path behind
   * `dehydrate()` and so behind `toJSON()` and every serialized response - is the only caller
   * that passes a FIFTH, the dehydrate options. That fifth parameter is the same seam
   * {@link SqlDatetimeValueConverter} reads for `dateTimeFormat`.
   *
   * Answering 0/1 to everyone breaks the contract the schema publishes: `columnToSchema`
   * documents a column carrying `BooleanValueConverter` as `{ type: 'boolean' }`, so a response
   * rendering `0` contradicts the model's own OpenAPI, and a generated client that validates its
   * responses rejects the payload outright.
   *
   * Discriminated on the ARITY, not on the value: `dehydrate()` may be called with no options at
   * all - `ModelBase.toJSON()` does exactly that - and `undefined` options still mean
   * "serializing", not "writing a row".
   *
   * @param value - property value to write to the database, or to dehydrate
   * @param _model - owning model, unused
   * @param _column - column descriptor, unused
   * @param _options - per-column converter options, unused
   * @param dehydrating - present only when the caller is `dehydrate()`
   */
  toDB(value: any, _model?: ModelBase<unknown>, _column?: IColumnDescriptor, _options?: any, ...dehydrating: [IDehydrateOptions?]) {
    return dehydrating.length > 0 ? !!value : value ? 1 : 0;
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

  /**
   * `fromDB` hands the model a {@link TimeSpan}, an instance of a class the ORM does not own.
   * Without this hook the snapshot could only mark such a column `UNCOPYABLE`, which never
   * compares equal to anything — so a `time` column was reported as changed on EVERY diff, with
   * no usable `OldValue`, and the model never converged to clean.
   *
   * A TimeSpan is fully described by its total milliseconds, so the baseline holds that number:
   * a copyable primitive that cannot alias the live value.
   *
   * @param value - the converted, in-memory column value
   */
  public snapshotValue(value: TimeSpan | number | null | undefined): number | null | undefined {
    if (value === null || value === undefined) {
      return value;
    }

    return value instanceof TimeSpan ? value.totalMilliseconds : value;
  }

  /**
   * Diff equality for a `time` column. Compares by total milliseconds, so the baseline number
   * produced by {@link snapshotValue} and a live `TimeSpan` compare as the same instant.
   *
   * Keeps the strictness of the generic `snapshotEquals`: `null` ("explicitly cleared") and
   * `undefined` ("never set") are different from each other and from any value.
   *
   * @param a - baseline value
   * @param b - current value
   */
  public snapshotEquals(a: TimeSpan | number | null | undefined, b: TimeSpan | number | null | undefined): boolean {
    if (a === b) {
      return true;
    }

    if (a === null || a === undefined || b === null || b === undefined) {
      return false;
    }

    const aMillis = a instanceof TimeSpan ? a.totalMilliseconds : a;
    const bMillis = b instanceof TimeSpan ? b.totalMilliseconds : b;

    return aMillis === bMillis;
  }
}

const SQL_DATETIME = 'yyyy-MM-dd HH:mm:ss.SSS';

/**
 * Writes an instant as the UTC wall clock with milliseconds, the text MySQL's DATETIME(3) and
 * TIMESTAMP(3) read in a UTC session. Reads any driver form back as a DateTime in UTC.
 *
 * Dehydrating (`toJSON()`, API payloads) writes `dateTimeFormat`, and ISO 8601 in UTC when none is
 * asked for, whatever the dialect stores. Told apart from a statement value by the arity, as in
 * {@link SqlBooleanValueConverter}.
 */
export class SqlDatetimeValueConverter extends DatetimeValueConverter {
  public toDB(value: unknown, _model?: ModelBase<unknown>, column?: IColumnDescriptor, _options?: unknown, ...dehydrating: [IDehydrateOptions?]): string | number | null {
    const dt = toInstant(value, column?.Name);
    if (dt === null) {
      return null;
    }

    const format = dehydrating.length > 0 ? (dehydrating[0]?.dateTimeFormat ?? 'iso') : undefined;
    switch (format) {
      case 'iso':
        return dt.toISO();
      case 'sql':
        return dt.toFormat(SQL_DATETIME);
      case 'unix':
        return dt.toUnixInteger();
    }

    if (column && DATE_NUMERICAL_TYPES.includes(column.Type)) {
      return dt.toUnixInteger();
    }

    return this.write(dt);
  }

  public fromDB(value: unknown): DateTime | null {
    return instantFromDb(value);
  }

  /** The column text of `dt`, a valid DateTime in UTC. */
  protected write(dt: DateTime): string {
    return dt.toFormat(SQL_DATETIME);
  }
}

/** ISO-8601 in UTC with `Z`: Postgres and MSSQL read it exactly, and its fixed width keeps SQLite text order time order. */
export class IsoDatetimeValueConverter extends SqlDatetimeValueConverter {
  protected write(dt: DateTime): string {
    return dt.toISO()!;
  }
}
