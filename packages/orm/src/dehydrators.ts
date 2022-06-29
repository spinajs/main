import { OrmException } from './exceptions';
import { RelationType } from './interfaces';
import { ModelBase } from './model';

export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase, omit?: string[]): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase, omit?: string[]) {
    const obj = {};

    model.ModelDescriptor.Columns?.forEach((c) => {
      if (omit && omit.indexOf(c.Name) !== -1) {
        return;
      }

      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val) : val;
    });

    for (const [, val] of model.ModelDescriptor.Relations) {
      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name]) {
          (obj as any)[val.ForeignKey] = (model as any)[val.Name].PrimaryKeyValue;
        }
      }
    }

    return obj;
  }
}
