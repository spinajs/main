import { ModelBase, RelationType } from '@spinajs/orm';
import { OrmException } from './exceptions';

export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase) {
    const obj = {};

    model.ModelDescriptor.Columns?.forEach((c) => {
      const val = (this as any)[c.Name];
      if (c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val) : val;
    });

    for (const [, val] of model.ModelDescriptor.Relations) {
      if (val.Type === RelationType.One) {
        if ((this as any)[val.Name]) {
          (obj as any)[val.ForeignKey] = (this as any)[val.Name].PrimaryKeyValue;
        }
      }
    }

    return obj;
  }
}
