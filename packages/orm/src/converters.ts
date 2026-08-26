import _ from 'lodash';
import { DateTime } from 'luxon';
import { OrmException } from './exceptions.js';
import { IUniversalConverterOptions, ModelToSqlConverter, RelationType, ValueConverter, ObjectToSqlConverter, IColumnDescriptor, IModelDescriptor } from './interfaces.js';
import { ModelBase } from './model.js';

export class JsonValueConverter extends ValueConverter {
  /**
   * Converts value to database type
   *
   * @param value - value to convert
   */
  public toDB(value: any): any {
    return JSON.stringify(value);
  }

  /**
   * Converts value from database type eg. mysql timestamp to DateTime
   *
   * @param value - value to convert
   */
  public fromDB(value: any): any {
    if (_.isObject(value) || _.isArray(value)) {
      return value;
    }

    return JSON.parse(value);
  }
}

/**
 * UUid converter to & from db as binary
 */
export class UuidConverter extends ValueConverter {
  public toDB(value: string) {
    const buffer = Buffer.alloc(16);

    if (!value) {
      return null;
    }

    buffer.write(value.replace(/-/g, ''), 'hex');

    return buffer;
  }

  public fromDB(value: Buffer | string) {
    if (!value) {
      return null;
    }

    // Rebuild the canonical dashed 36-char form (8-4-4-4-12) so a save/load
    // round-trip preserves the original key identity ( toDB strips the dashes
    // back to a 16-byte BINARY ).
    const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value).replace(/-/g, '');

    if (hex.length !== 32) {
      // not a 16-byte uuid - return as-is rather than emit a malformed value
      return Buffer.isBuffer(value) ? hex : String(value);
    }

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/**
 * Universal converter for "type column" tables - text columns whose runtime
 * type is decided by a sibling column (named by `options.TypeColumn`).
 *
 * Values are stored & read in canonical form: numbers as decimal text, booleans
 * as `'true'` / `'false'`, dates / times / datetimes as ISO 8601, json as JSON.
 */
export class UniversalValueConverter extends ValueConverter {
  public toDB(value: any, model: ModelBase, _column: IColumnDescriptor, options: IUniversalConverterOptions) {
    // null / undefined can't be type-converted - persist as-is
    if (value === null || value === undefined) {
      return value;
    }

    const type = model ? (model as any)[options.TypeColumn] : (typeof value).toLowerCase();
    switch (type) {
      case 'boolean':
        return value ? 'true' : 'false';
      case 'datetime':
        return (value as DateTime).toISO();
      case 'date':
        return (value as DateTime).toISODate();
      case 'time':
        return (value as DateTime).toISOTime({ includeOffset: false });
      case 'float':
      case 'number':
        return (value as number).toString();
      case 'json':
        return JSON.stringify(value);
      case 'string':
      default:
        return value;
    }
  }

  public fromDB(value: any, raw: any, options: IUniversalConverterOptions) {
    // nothing to parse for empty values
    if (value === null || value === undefined || value === '') {
      return value;
    }

    switch (raw[options.TypeColumn]) {
      case 'boolean':
        return value === 'true';
      case 'datetime':
      case 'date':
      case 'time':
        return DateTime.fromISO(value as string);
      case 'float':
        return parseFloat(value as string);
      case 'number':
        return parseInt(value as string, 10);
      case 'json':
        return _.isObject(value) ? value : JSON.parse(value as string);
      case 'string':
      default:
        return value;
    }
  }
}

export class StandardModelToSqlConverter extends ModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const obj = {};
    const relArr = [...model.ModelDescriptor!.Relations.values()];

    // Foreign-key columns are normally written via their relation (the loop
    // below sets obj[ForeignKey] from the related model). But a FK column with no
    // backing relation on the model (e.g. a plain owner-id column such as
    // user_sessions.UserId) would otherwise never be serialized at all, breaking
    // INSERTs that hit its NOT NULL constraint. So only skip FK columns that an
    // actual relation manages; serialize unrelated FK columns like normal ones.
    const relationForeignKeys = new Set(relArr.map((r) => r.ForeignKey));

    model.ModelDescriptor!.Columns?.filter((x) => !x.Virtual && (!x.IsForeignKey || !relationForeignKeys.has(x.Name))).forEach((c) => {
      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val, model, c, model.ModelDescriptor!.Converters.get(c.Name)?.Options) : val;
    });

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        const relation = (model as any)[val.Name];
        if (relation?.Value) {
          // The join column, not the target's own primary key: @BelongsTo may name another one.
          (obj as any)[val.ForeignKey] = relation.Value[val.PrimaryKey];
        } else if ((model as any)[val.ForeignKey] != null) {
          // Never attached, or populate() found no row for the key the row carries: the raw
          // column is the value. Without this, InsertOrUpdate emits the FK as an empty binding
          // and orphans the row.
          (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
        } else if (relation && relation.Value === null) {
          // Detached: attach(null) cleared the relation AND the column, and that is what a
          // detach means for the row - the key is written as NULL.
          (obj as any)[val.ForeignKey] = null;
        }
      }

      // HACK: This is a hack to fix the issue with the recursive relation
      // recursive relations usually dont ahve set @belongsTo but @HasMany decorator and are not in list  of relaitons 
      if (val.Recursive) {
        (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
      }
    }

    return obj;
  }
}

export class StandardObjectToSqlConverter extends ObjectToSqlConverter {
  public toSql(model: unknown, descriptor: IModelDescriptor): unknown {
    const obj = {};
    const relArr = [...descriptor.Relations.values()];

    descriptor.Columns.forEach((c) => {
      const val = (model as any)[c.Name];
      if (val === undefined) return;
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val, undefined as unknown as ModelBase, c, descriptor.Converters.get(c.Name)?.Options) : val;
    });

    relArr
      .filter((r) => r.Type === RelationType.One)
      .forEach((r) => {
        if ((model as any)[r.Name] instanceof ModelBase) {
          (obj as any)[r.ForeignKey] = (model as any)[r.Name].PrimaryKeyValue;
        }
      });

    return obj;
  }
}
