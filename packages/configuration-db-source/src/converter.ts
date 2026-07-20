/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable prettier/prettier */
import { Singleton } from '@spinajs/di';
import { extractDecoratorPropertyDescriptor, IColumnDescriptor, IModelDescriptor, IUniversalConverterOptions, ModelBase, UniversalValueConverter } from '@spinajs/orm';
import _ from 'lodash';
import { DateTime } from 'luxon';

/**
 * Value converter for the configuration table.
 *
 * The universal primitives (number / float / string / boolean / json / date /
 * time / datetime) are handled by {@link UniversalValueConverter}; this subclass
 * adds the configuration-specific composite types on top:
 *
 *   - `oneOf` / `file`            -> plain string
 *   - `range`                     -> number
 *   - `manyOf`                    -> JSON array (string[])
 *   - `date-range` / `time-range` / `datetime-range` -> DateTime[], ISO values joined by ';'
 *
 * All values are stored & read in canonical form (ISO dates/times, decimal
 * numbers, `true`/`false` booleans).
 *
 * `toDB` is the single conversion point: it canonicalizes whatever shape the
 * value happens to be in (an already-typed model value such as a luxon
 * `DateTime`, or the loose JSON the http layer assigns straight from a request -
 * ISO strings, numeric strings, `'1'`/`'0'` booleans). Callers therefore don't
 * have to pre-coerce; they validate and hand the raw value over.
 */
@Singleton()
export class DbConfigValueConverter extends UniversalValueConverter {
  public toDB(value: any, model: ModelBase, column: IColumnDescriptor, options: IUniversalConverterOptions): any {
    if (value === null || value === undefined) {
      return value;
    }

    switch (this.resolveType(value, model, options)) {
      case 'oneOf':
      case 'file':
        return value as string;
      case 'range':
        return Number(value).toString();
      case 'manyOf':
        return JSON.stringify(value);
      case 'boolean':
        return this.toBool(value) ? 'true' : 'false';
      case 'date':
        return this.toDateTime(value).toISODate();
      case 'time':
        return this.toDateTime(value).toISOTime({ includeOffset: false });
      case 'datetime':
        return this.toDateTime(value).toISO();
      case 'date-range':
        return (value as unknown[]).map((x) => this.toDateTime(x).toISODate()).join(';');
      case 'time-range':
        return (value as unknown[]).map((x) => this.toDateTime(x).toISOTime({ includeOffset: false })).join(';');
      case 'datetime-range':
        return (value as unknown[]).map((x) => this.toDateTime(x).toISO()).join(';');
      default:
        return super.toDB(value, model, column, options);
    }
  }

  /** Accepts an already-typed `DateTime` or an ISO string. */
  private toDateTime(value: unknown): DateTime {
    return DateTime.isDateTime(value) ? value : DateTime.fromISO(value as string);
  }

  /** Accepts a real boolean or the canonical / numeric string forms. */
  private toBool(value: unknown): boolean {
    if (typeof value === 'string') {
      return value === '1' || value === 'true';
    }
    return Boolean(value);
  }

  public fromDB(value: any, raw: any, options: IUniversalConverterOptions): any {
    if (value === null || value === undefined || value === '') {
      return value;
    }

    switch (raw[options.TypeColumn]) {
      case 'oneOf':
      case 'file':
        return value as string;
      case 'range':
        return Number(value);
      case 'manyOf':
        return _.isArray(value) ? value : (JSON.parse(value as string) as string[]);
      case 'date-range':
      case 'time-range':
      case 'datetime-range':
        return (value as string).split(';').map((x) => DateTime.fromISO(x));
      default:
        return super.fromDB(value, raw, options);
    }
  }

  private resolveType(value: any, model: ModelBase, options: IUniversalConverterOptions): string {
    if (model) {
      return (model as any)[options.TypeColumn];
    }

    // no model context (eg. update partials) - infer from the runtime value
    return (typeof value).toLowerCase();
  }
}

/**
 * Attaches {@link DbConfigValueConverter} to a model property, reading the
 * entry type from `typeColumn` (defaults to `Type`).
 */
export function DbConfigValue(typeColumn = 'Type') {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    model.Converters.set(propertyKey, {
      Class: DbConfigValueConverter,
      Options: { TypeColumn: typeColumn },
    });
  });
}
