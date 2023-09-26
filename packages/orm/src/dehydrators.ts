import { OrmException } from './exceptions.js';
import { RelationType } from './interfaces.js';
import { ModelBase } from './model.js';
import { Relation } from './relation-objects.js';
 
export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase, omit?: string[]): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase, omit?: string[]) {
    const obj = {};
    const relArr = [...model.ModelDescriptor.Relations.values()];

    model.ModelDescriptor.Columns?.forEach((c) => {
      // if in omit list OR it is foreign key for relation - skip
      if ((omit && omit.indexOf(c.Name) !== -1) || (relArr.find((r) => r.ForeignKey === c.Name) && !c.PrimaryKey)) {
        return;
      }

      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val, model, null) : val;
    });

    return obj;
  }
}

export class StandardModelWithRelationsDehydrator extends StandardModelDehydrator {
  public dehydrate(model: ModelBase<unknown>, omit?: string[]): any {
    const obj = super.dehydrate(model, omit);
    const relArr = [...model.ModelDescriptor.Relations.values()];

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name].Value) {
          (obj as any)[val.Name] = (model as any)[val.Name].Value.dehydrateWithRelations();
        }
      }

      if (val.Type === RelationType.Many) {
        if ((model as any)[val.Name]) {
          (obj as any)[val.Name] = [...((model as any)[val.Name] as Relation<ModelBase, any>).map((x) => x.dehydrateWithRelations())];
        }
      }
    }

    return obj;
  }
}
