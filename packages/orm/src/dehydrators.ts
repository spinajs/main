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
    const relByForeignKey = new Map([...model.ModelDescriptor!.Relations.values()].filter((r) => r.Type === RelationType.One).map((r) => [r.ForeignKey, r]));

    model.ModelDescriptor!.Columns?.forEach((c) => {
      // Only the omit list decides, and `@Hidden()` rides in on it ( model.ts appends
      // `descriptor.Hidden` to `omit` for both dehydrate entry points ), so a foreign key a model
      // does not want to hand out is hidden the same way any other column is.
      //
      // A relation's foreign key USED to be skipped here, on the assumption that the relation
      // itself carries the link. It does not always: `dehydrate()` emits no relations at all, and
      // `dehydrateWithRelations()` emits one only when it is populated - so an unpopulated
      // relation dropped the association from the payload entirely. The column is a real,
      // documented column ( the schema generator publishes it, since it is in `Columns` ), and a
      // consumer needs it to write the row back.
      if (options?.omit && options?.omit.indexOf(c.Name) !== -1) {
        return;
      }

      // A foreign key can live in the RELATION rather than in its own column: `SingleRelation.attach()`
      // points the relation at the related model and marks the key dirty, but never copies the value
      // across - the INSERT resolves it at write time, which is what `ModelToSqlConverter` does with
      // `obj[val.ForeignKey] = model[val.Name].Value.PrimaryKeyValue`. A model that was attached and
      // then answered straight back ( the POST response ) therefore still has an empty column and the
      // whole link in the relation, so read the same fallback here. Both are the same fact.
      const relation = relByForeignKey.get(c.Name);
      const own = (model as any)[c.Name];
      const val = (own === null || own === undefined) && relation ? ((model as any)[relation.Name]?.Value?.PrimaryKeyValue ?? own) : own;

      if (!c.PrimaryKey && !c.Nullable && !options?.ignoreNullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }

      const v = c.Converter ? c.Converter.toDB(val, model, c, model.ModelDescriptor!.Converters.get(c.Name)?.Options, options) : val;
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
    const relArr = [...model.ModelDescriptor!.Relations.values()];

    for (const val of relArr) {
      if (options?.omit && options?.omit.indexOf(val.Name) !== -1) {
        continue;
      }

      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name]?.Value) {
          (obj as any)[val.Name] = (model as any)[val.Name].Value.dehydrateWithRelations({
            ...options,
            omit: []
          });
        }

        // An unpopulated relation writes NOTHING. It used to fall back to the raw foreign key
        // under the RELATION's name, which gave one key two types - the related model when
        // `populate()` had run, a bare number when it had not - decided per query by `include`.
        // No JSON schema can describe that, and the generator does not try: it publishes the
        // relation as its target model, so the fallback made a documented object arrive as an
        // integer and any client validating the response rejected it.
        //
        // The link is not lost. The foreign key column is dehydrated like any other column above,
        // which is the honest place for it: one name, one type, always present.
      } else {
        if ((model as any)[val.Name]) {
          const v = [...((model as any)[val.Name] as Relation<ModelBase, any, typeof ModelBase>)];
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
