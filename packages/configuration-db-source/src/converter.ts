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
 * numbers, `true`/`false` booleans) - there is no legacy-format tolerance.
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
        return (value as number).toString();
      case 'manyOf':
        return JSON.stringify(value);
      case 'date-range':
        return (value as DateTime[]).map((x) => x.toISODate()).join(';');
      case 'time-range':
        return (value as DateTime[]).map((x) => x.toISOTime({ includeOffset: false })).join(';');
      case 'datetime-range':
        return (value as DateTime[]).map((x) => x.toISO()).join(';');
      default:
        return super.toDB(value, model, column, options);
    }
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
