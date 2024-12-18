import _ from 'lodash';
import { DateTime } from 'luxon';
import { OrmException } from './exceptions.js';
import { IUniversalConverterOptions, ModelToSqlConverter, RelationType, ValueConverter, ObjectToSqlConverter, IColumnDescriptor } from './interfaces.js';
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

  public fromDB(value: Buffer) {
    return value.toString('hex');
  }
}

export class UniversalValueConverter extends ValueConverter {
  public toDB(value: any, model: ModelBase, _column: IColumnDescriptor, options: IUniversalConverterOptions) {
    const type = model ? (model as any)[options.TypeColumn] : (typeof value).toLowerCase();
    switch (type) {
      case 'string':
        return value;
      case 'boolean':
        return value ? 'true' : 'false';
      case 'datetime':
        return (value as DateTime).toISO();
      case 'float':
      case 'number':
        (value as number).toString();
      case 'json':
        return JSON.stringify(value);
    }
  }

  public fromDB(value: string, raw: any, options: IUniversalConverterOptions) {
    switch (raw[options.TypeColumn]) {
      case 'boolean':
        return value === 'true' ? true : false;
      case 'datetime':
        return DateTime.fromISO(value);
      case 'float':
        return parseFloat(value);
      case 'number':
        return parseInt(value, 10);
      case 'json':
        return JSON.parse(value);
      case 'string':
      default:
        return value;
    }
  }
}

export class StandardModelToSqlConverter extends ModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const obj = {};
    const relArr = [...model.ModelDescriptor.Relations.values()];

    model.ModelDescriptor.Columns?.filter((x) => !x.IsForeignKey).forEach((c) => {
      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val, model, c, model.ModelDescriptor.Converters.get(c.Name).Options) : val;
    });

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name].Value) {
          (obj as any)[val.ForeignKey] = (model as any)[val.Name].Value.PrimaryKeyValue;
        }
      }
    }

    return obj;
  }
}

export class StandardObjectToSqlConverter extends ObjectToSqlConverter {
  public toSql(model: unknown): unknown {
    return model;
  }
}
