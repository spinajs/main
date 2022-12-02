import _ from 'lodash';
import { DateTime } from 'luxon';
import { IUniversalConverterOptions, ValueConverter } from './interfaces';
import { ModelBase } from './model';

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
  public toDB(value: any, model: ModelBase, options: IUniversalConverterOptions) {
    switch ((model as any)[options.TypeColumn]) {
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
      case 'string':
        return value;
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
    }
  }
}
