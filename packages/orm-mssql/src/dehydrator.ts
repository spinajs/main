import { ModelBase, StandardModelDehydrator } from '@spinajs/orm';

export class MssqlModelDehydrator extends StandardModelDehydrator {
  public dehydrate(model: ModelBase) {
    const obj = super.dehydrate(model);
    const pColumn = model.ModelDescriptor.Columns.find((c) => c.PrimaryKey);

    // MSSQL do not allow for NULL when inserting with primary key
    if (pColumn && !(obj as any)[pColumn.Name]) {
      delete (obj as any)[pColumn.Name];
    }

    return obj;
  }
}
