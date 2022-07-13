import { OrmException } from './exceptions';
import { RelationType } from './interfaces';
import { ModelBase } from './model';
import { Relation } from './relations';

export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase, omit?: string[]): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase, omit?: string[]) {
    const obj = {};
    const relArr = [...model.ModelDescriptor.Relations.values()];
    model.ModelDescriptor.Columns?.forEach((c) => {
      // if in omit list OR it is foreign key for relation - skip
      if ((omit && omit.indexOf(c.Name) !== -1) || relArr.find((r) => r.ForeignKey === c.Name)) {
        return;
      }

      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val) : val;
    });

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name].Value) {
          (obj as any)[val.Name] = (model as any)[val.Name].Value.dehydrate();
        }
      }

      if (val.Type === RelationType.Many) {
        if ((model as any)[val.Name]) {
          (obj as any)[val.Name] = [...((model as any)[val.Name] as Relation<ModelBase>).map((x) => x.dehydrate())];
        }
      }
    }

    return obj;
  }
}
