/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { IColumnDescriptor, ModelBase, ModelToSqlConverter, OrmException, normalizeSqlType } from '@spinajs/orm';
import { IsoDatetimeValueConverter } from '@spinajs/orm-sql';

// The type names SQLite documents for the INTEGER and REAL affinities, plus NUMERIC and DECIMAL. DATETIME, DATE and
// BOOLEAN have the NUMERIC affinity too and stay out.
const NUMERIC_TYPES = new Set(['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'big int', 'int2', 'int8', 'real', 'double', 'double precision', 'float', 'numeric', 'decimal']);

/**
 * {@link IsoDatetimeValueConverter} that knows a numeric column by SQLite's type names. SQLite reports a column type
 * as declared ( `INTEGER`, `DECIMAL(10,2)` ), which the lower-case type list of the shared converter does not match.
 */
export class SqliteDatetimeValueConverter extends IsoDatetimeValueConverter {
  protected isNumericColumn(column: IColumnDescriptor): boolean {
    return NUMERIC_TYPES.has(normalizeSqlType(column.Type ?? ''));
  }
}

export class SqliteModelToSqlConverter extends ModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const obj = {};
    const relArr = [...model.ModelDescriptor!.Relations.values()];

    // Foreign-key columns are normally written via their relation (`relationForeignKeys()`
    // sets obj[ForeignKey] from the related model). But a FK column with no
    // backing relation on the model (e.g. a plain owner-id column such as
    // user_sessions.UserId) would otherwise never be serialized at all, breaking
    // INSERTs that hit its NOT NULL constraint. So only skip FK columns that an
    // actual relation manages; serialize unrelated FK columns like normal ones.
    const managedForeignKeys = new Set(relArr.map((r) => r.ForeignKey));

    // `Virtual` entries are filter-only properties with no column behind them, `@Ignore()` ones are
    // not persisted - neither is ever written.
    model.ModelDescriptor!.Columns?.filter((x) => !x.Virtual && !x.Ignore && (!x.IsForeignKey || !managedForeignKeys.has(x.Name))).forEach((c) => {
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

    return Object.assign(obj, this.relationForeignKeys(model));
  }
}
