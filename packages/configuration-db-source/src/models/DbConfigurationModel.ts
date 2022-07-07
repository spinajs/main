/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, ModelBase } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('configuration')
export class DbConfigurationModel extends ModelBase {

  @Primary()
  public Id: number;

  public Slug: string;

  public Value?: unknown;

  public Group: string;

  public Type: 'int' | 'float' | 'string' | 'json' | 'date' | 'datetime' | 'time' | 'boolean';

  public hydrate(data: Partial<this>) { 
    Object.assign(this, {...data, Value: this.parse(data.Value as string) })
  }

  public dehydrate(_includeRelations?: boolean, _omit?: string[]) {
      return {
           Id: this.Id,
         Slug: this.Slug,
        Group: this.Group,
         Type: this.Type,
        Value: this.stringify(this.Value)
      } as any;
  }

  private parse(input : string){
    switch(this.Type){
        case 'int':
        case 'float':
          return  Number(input);
        case 'datetime':
          return DateTime.fromISO(input);
        case "time":
          return DateTime.fromFormat(input, "HH:mm:ss");
        case "date": 
          return DateTime.fromFormat(input, "dd-MM-YYYY");
        case "json":
          return JSON.parse(input) as unknown;
        break;
         
    }
  }

  private stringify(val: number | string | DateTime | boolean | unknown) {
    switch (this.Type) {
      case 'json':
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        return this.Value = JSON.stringify(val);
      case 'date':
        return this.Value = (val as DateTime).toFormat('dd-MM-YYYY');
      case 'time':
        return this.Value = (val as DateTime).toFormat('HH:mm:ss');
      case 'datetime':
        return this.Value = (val as DateTime).toISO();
      case 'string':
      case 'int':
      case 'float':
      default:
        return `${val}`;
    
    }
  }
}
