/* eslint-disable security/detect-object-injection */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ModelBase, ModelToSqlConverter, OrmException, RelationType } from '@spinajs/orm';

export class SqliteModelToSqlConverter extends ModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const obj = {};
    const relArr = [...model.ModelDescriptor!.Relations.values()];

    // Foreign-key columns are normally written via their relation (the loop
    // below sets obj[ForeignKey] from the related model). But a FK column with no
    // backing relation on the model (e.g. a plain owner-id column such as
    // user_sessions.UserId) would otherwise never be serialized at all, breaking
    // INSERTs that hit its NOT NULL constraint. So only skip FK columns that an
    // actual relation manages; serialize unrelated FK columns like normal ones.
    const relationForeignKeys = new Set(relArr.map((r) => r.ForeignKey));

    model.ModelDescriptor!.Columns?.filter((x) => !x.IsForeignKey || !relationForeignKeys.has(x.Name)).forEach((c) => {
      const val = (model as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }

      // undefined properties we omit,
      // assume that those values have default value in DB defined,
      // SQLITE does not support DEFAULT keyword in insert statements
      // this way insertquerycompiler will not try to fill DEFAULT in missing data
      if (val === undefined) return;

      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val, model, c, model.ModelDescriptor!.Converters.get(c.Name)?.Options) : val;
    });

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        if ((model as any)[val.Name].Value) {
          (obj as any)[val.ForeignKey] = (model as any)[val.Name].Value.PrimaryKeyValue;
        } else if ((model as any)[val.ForeignKey] != null) {
          // Fallback: when the BelongsTo SingleRelation has no Value (e.g. the FK
          // was set directly / translated from a resolved model instance rather
          // than by attaching the relation), serialize the raw FK column so the
          // update/insert still persists it instead of silently dropping it.
          (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
        }
      }

      // HACK: This is a hack to fix the issue with the recursive relation
      // recursive relations usually dont ahve set @belongsTo but @HasMany decorator and are not in list  of relaitons
      if (val.Recursive) {
        (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
      }
    }

    return obj;
  }
}
