/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, ModelBase } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('TestTable1')
export class DbConfigurationModel extends ModelBase {
  private _realValue: number | string | DateTime | boolean | unknown;

  @Primary()
  public Id: number;

  public Slug: string;

  public Value?: unknown;

  public Group: string;

  public Type: 'int' | 'float' | 'string' | 'json' | 'date' | 'datetime' | 'time' | 'boolean';

  public get RealValue(): number | string | DateTime | boolean | unknown {
    return this._realValue;
  }

  public set RealValue(val: number | string | DateTime | boolean | unknown) {
    this._realValue = val;

    switch (this.Type) {
      case 'string':
      case 'int':
      case 'float':
        this.Value = `${val}`;
        break;
      case 'json':
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.Value = JSON.stringify(val);
        break;
      case 'date':
        this.Value = (val as DateTime).toFormat('dd-MM-YYYY');
        break;
      case 'time':
        this.Value = (val as DateTime).toFormat('HH:mm:ss');
        break;
      case 'datetime':
        this.Value = (val as DateTime).toISO();
        break;
    }
  }
}
