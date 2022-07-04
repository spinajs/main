import { OrmException } from './exceptions';
import { RelationType } from './interfaces';
import { ModelBase } from './model';

export abstract class ModelDehydrator {
  public abstract dehydrate(model: ModelBase, includeRelations?: boolean, omit?: string[]): any;
}

export class StandardModelDehydrator extends ModelDehydrator {
  public dehydrate(model: ModelBase, includeRelations?: boolean, omit?: string[]) {
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

    if (includeRelations) {
      for (const [, val] of model.ModelDescriptor.Relations) {
        if (val.Type === RelationType.One) {
          if ((model as any)[val.Name]) {
            (obj as any)[val.Name] = (model as any)[val.Name].UnderlyingValue ? (model as any)[val.Name].dehydrate() : undefined;
          }
        }

        if (val.Type === RelationType.Many) {
          if ((model as any)[val.Name]) {
            (obj as any)[val.Name] = (model as any)[val.Name].map((x: any) => x.dehydrate());
          }
        }
      }
    }

    return obj;
  }
}
