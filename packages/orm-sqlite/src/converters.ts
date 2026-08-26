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
        const relation = (model as any)[val.Name];
        if (relation?.Value) {
          // The join column, not the target's own primary key: @BelongsTo may name another one.
          (obj as any)[val.ForeignKey] = relation.Value[val.PrimaryKey];
        } else if ((model as any)[val.ForeignKey] != null) {
          // Fallback: when the BelongsTo SingleRelation has no Value (e.g. the relation was
          // never populated, or the foreign key was written directly), fall back to the raw
          // FK column. Without this the column is dropped from every payload, because the
          // filter above already excluded it as relation-managed - so a row whose owner
          // changed would silently keep its old foreign key.
          //
          // Mirrors StandardModelToSqlConverter in @spinajs/orm, which grew this branch
          // while this override did not.
          (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
        } else if (relation && relation.Value === null) {
          // Detached: attach(null) cleared the relation AND the column, and that is what a
          // detach means for the row - the key is written as NULL. Mirrors
          // StandardModelToSqlConverter; without it the UPDATE payload comes out empty and
          // the foreign key can never be cleared.
          (obj as any)[val.ForeignKey] = null;
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
