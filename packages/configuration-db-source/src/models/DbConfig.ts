/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, ModelBase } from '@spinajs/orm';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { ConfigurationEntryType, IConfigurationEntryMeta } from '../types.js';

@Connection('default')
@Model('configuration')
export class DbConfig<T = unknown> extends ModelBase {
  @Primary()
  public Id: number;

  public Slug: string;

  public Value?: T;

  public Group: string;

  public Label?: string;

  public Description?: string;

  public Meta?: IConfigurationEntryMeta;

  public Required: boolean;

  public Type: ConfigurationEntryType;

  public Watch: boolean;

  public Default?: T;

  public hydrate(data: Partial<this>) {
    Object.assign(this, {
      ...data,
      Value: parse(data.Value as unknown as string, data.Type),
      Default: parse(data.Value as unknown as string, data.Type)
    });
  }

  public dehydrate(_omit?: string[]) {
    return {
      ...this,
      Value: this.stringify(this.Value),
      Default: this.stringify(this.Default)
    } as any;
  }

  private stringify(val: number | string | DateTime | boolean | unknown | DateTime[] | string[]) {
    if (val instanceof DateTime) {
      switch (this.Type) {
        case 'date':
          return val.toFormat('dd-MM-yyyy');
        case 'time':
          return val.toFormat('HH:mm:ss');
        case 'datetime':
          return val.toISO();
      }
    }

    if (_.isArray(val)) {
      switch (this.Type) {
        case 'date-range':
          return val.map((x: DateTime) => x.toFormat('dd-MM-yyyy')).join(';');
        case 'time-range':
          return val.map((x: DateTime) => x.toFormat('HH:mm:ss')).join(';');
        case 'datetime-range':
          return val.map((x: DateTime) => x.toISO()).join(';');
      }
    }

    if (this.Type === 'manyOf') {
      return JSON.stringify(val);
    }

    if (_.isString(val) || _.isNumber(val) || _.isBoolean(val)) {
      return `${val}`;
    }

    return JSON.stringify(val);
  }
}

export function parse(input: string, type: string) {
  switch (type) {
    case 'string':
    case 'file':
    case 'oneOf':
      return input;
    case 'int':
    case 'float':
    case 'range':
      return Number(input);
    case 'boolean':
      return input === '1' ? true : false;
    case 'datetime':
      return DateTime.fromISO(input);
    case 'time':
      return DateTime.fromFormat(input, 'HH:mm:ss');
    case 'date':
      return DateTime.fromFormat(input, 'dd-MM-yyyy');
    case 'datetime-range':
      return input.split(';').map((x) => DateTime.fromISO(x));
    case 'time-range':
      return input.split(';').map((x) => DateTime.fromFormat(x, 'HH:mm:ss'));
    case 'date-range':
      return input.split(';').map((x) => DateTime.fromFormat(x, 'dd-MM-yyyy'));
    default:
      return JSON.parse(input) as unknown;
  }
}
