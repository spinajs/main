import { OrmException } from './exceptions.js';
import { IDehydrateOptions, RelationType } from './interfaces.js';
import { ModelBase } from './model.js';
import { Relation } from './relation-objects.js';

export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase, options?: IDehydrateOptions): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase, options?: IDehydrateOptions) {
    const obj = {};
    const relArr = [...model.ModelDescriptor.Relations.values()];

    model.ModelDescriptor.Columns?.forEach((c) => {
      // if in omit list OR it is foreign key for relation - skip
      if ((options?.omit && options?.omit.indexOf(c.Name) !== -1) || (relArr.find((r) => r.ForeignKey === c.Name) && !c.PrimaryKey)) {
        return;
      }

      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }

      const v = c.Converter ? c.Converter.toDB(val, model, c, model.ModelDescriptor.Converters.get(c.Name)?.Options, options) : val;
      if (options?.skipNull && v === null) {
        return;
      }

      if (options?.skipUndefined && v === undefined) {
        return;
      }

      if (options?.skipEmptyArray && (Array.isArray(v) && v.length === 0)) {
        return;
      }

      (obj as any)[c.Name] = v;
    });

    return obj;
  }
}

export class StandardModelWithRelationsDehydrator extends StandardModelDehydrator {
  public dehydrate(model: ModelBase<unknown>, options?: IDehydrateOptions): any {
    const obj = super.dehydrate(model, options);
    const relArr = [...model.ModelDescriptor.Relations.values()];

    for (const val of relArr) {
      if (options?.omit && options?.omit.indexOf(val.Name) !== -1) {
        continue;
      }

      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name].Value) {
          (obj as any)[val.Name] = (model as any)[val.Name].Value.dehydrateWithRelations({
            ...options,
            omit: []
          });
        } else {
          // if relation is not ( eg. not populated full relation data ) return at least foreign keys
          (obj as any)[val.Name] = (model as any)[val.ForeignKey];
        }
      } else {
        if ((model as any)[val.Name]) {
          const v = [...((model as any)[val.Name] as Relation<ModelBase, any>)];
          if (v.length === 0) {
            (obj as any)[val.Name] = [];
          } else {
            (obj as any)[val.Name] = v.map((x) => x.dehydrateWithRelations({
              ...options,
              omit: []
            }));
          }
        }
      }
    }

    return obj;
  }
}
