/* eslint-disable @typescript-eslint/no-explicit-any */
import { IColumnDescriptor, IDehydrateOptions, JsonValueConverter, ModelBase, toInstant } from '@spinajs/orm';
import { IsoDatetimeValueConverter } from '@spinajs/orm-sql';
import { DateTime } from 'luxon';

const PG_NUMERIC_TYPES = ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'];

/**
 * {@link IsoDatetimeValueConverter} ( UTC instants ) with two exceptions: an unset value stays
 * unset, and a DATE column takes the calendar day of the value in its own zone.
 */
export class PostgresDatetimeValueConverter extends IsoDatetimeValueConverter {
  public toDB(value: unknown, model?: ModelBase<unknown>, column?: IColumnDescriptor, options?: unknown, ...dehydrating: [IDehydrateOptions?]): any {
    // undefined stays undefined: the insert then writes DEFAULT (e.g. CURRENT_TIMESTAMP) instead of NULL
    if (value === undefined) {
      return undefined;
    }

    if (dehydrating.length === 0 && column?.Type === 'date') {
      const day = DateTime.isDateTime(value) ? value : value instanceof Date ? DateTime.fromJSDate(value) : null;
      if (day?.isValid) {
        return day.toISODate();
      }
    }

    // tableInfo() reports udt names ( int8, float8 ), which the shared numeric-type list does not know
    if (dehydrating.length === 0 && column && PG_NUMERIC_TYPES.includes(column.Type)) {
      return toInstant(value, column.Name)?.toUnixInteger() ?? null;
    }

    return super.toDB(value, model, column, options, ...dehydrating);
  }

  public fromDB(value: unknown): DateTime | null {
    // model construction runs assigned values through here too; converting the zone would move a DATE's day
    if (DateTime.isDateTime(value) && value.isValid) {
      return value;
    }

    return super.fromDB(value);
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
