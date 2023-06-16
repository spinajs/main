import { Injectable, NewInstance } from '@spinajs/di';
import { format } from '@spinajs/configuration';
import { IColumnDescriptor, OrmDriver, QueryBuilder, TransactionCallback, Builder, QueryContext, SqlOperator, Wrap, UpdateQueryBuilder, InsertQueryBuilder, DeleteQueryBuilder, WhereBuilder, ColumnStatement } from '@spinajs/orm';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import _ from 'lodash';
import { WhereStatement } from '@spinajs/orm';
import { OrmException } from '@spinajs/orm';

class LowWithLodash<T> extends Low<T> {
  chain: _.ExpChain<this['data']> = _.chain(this).get('data');
}

interface LowDBData {
  [key: string]: any[];
}

@Injectable('orm-driver-lowdb')
@NewInstance()
export class LowDBDriver extends OrmDriver {
  protected executionId = 0;

  protected adapter: JSONFile<LowDBData>;
  protected db: LowWithLodash<LowDBData>;

  public execute(builder: Builder<any>): Promise<unknown> {
    /**
     * We skip all compilation process
     * We take builder and query lowdb data
     *
     * Support for full orm builder function is limited
     */
    switch (builder.QueryContext) {
      case QueryContext.Delete:
        return this.handleDelete(builder as DeleteQueryBuilder<unknown>);
      case QueryContext.Insert:
        return this.handleInsert(builder as InsertQueryBuilder);
      case QueryContext.Update:
        return this.handleUpdate(builder as UpdateQueryBuilder<unknown>);
      case QueryContext.Select:
        return this.handleSelect(builder as QueryBuilder<any>);
    }
  }

  protected async handleInsert(builder: InsertQueryBuilder) {
    if (!this.db.data[builder.Table]) {
      this.db.data[builder.Table] = [];
    }

    const data: any[] = [];

    builder.Values.forEach((val) => {
      const d: any = {};
      builder.getColumns().forEach((x: ColumnStatement, cIndex) => {
        if (_.isString(x.Column)) {
          d[x.Column] = val[cIndex];
        }
      });

      data.push(d);
    });

    this.db.data[builder.Table] = this.db.data[builder.Table].concat(...data);

    await this.db.write();
  }

  protected async handleDelete(builder: DeleteQueryBuilder<any>) {
    const data = await this.handleSelect(builder);

    if (!data || data.length === 0) {
      return;
    }

    this.db.chain.get(builder.Table).remove(data);

    await this.db.write();
  }

  protected async handleUpdate(builder: UpdateQueryBuilder<any>) {
    const data = await this.handleSelect(builder);

    if (!data || data.length === 0) {
      return;
    }

    Object.assign(data[0], builder.Value);

    await this.db.write();
  }

  protected async handleSelect(builder: QueryBuilder<any>) {
    // double cast for linter
    // we are sure that builder passed here implements this class
    // by mixins
    const wb = builder as any as WhereBuilder<any>;

    return this.db.chain
      .get(builder.Table)
      .filter((x) => {
        if (
          !wb.Statements.every((qs) => {
            return qs instanceof WhereStatement;
          })
        ) {
          throw new OrmException(`Lowdb does not support raw queries`);
        }

        return wb.Statements.every((stmt: WhereStatement) => {
          if (stmt.Column instanceof Wrap) {
            return false;
          }

          const val = (x as any)[stmt.Column];
          switch (stmt.Operator) {
            case SqlOperator.EQ:
              return val === stmt.Value;
            case SqlOperator.GT:
              return val > stmt.Value;
            case SqlOperator.GTE:
              return val >= stmt.Value;
            case SqlOperator.NULL:
              return val === null || val === undefined;
            case SqlOperator.LT:
              return val < stmt.Value;
            case SqlOperator.LTE:
              return val <= stmt.Value;
            case SqlOperator.NOT:
              return val !== stmt.Value;
            case SqlOperator.NOT_NULL:
              return val !== null && val !== undefined;
            case SqlOperator.LIKE:
              return (val as string).includes(stmt.Value);
            case SqlOperator.IN:
              return (stmt.Value as any[]).indexOf(val) !== -1;
            case SqlOperator.NOT_IN:
              return (stmt.Value as any[]).indexOf(val) === -1;
          }
        });
      })
      .value();
  }

  public async ping(): Promise<boolean> {
    return this.db !== null && this.db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    this.adapter = new JSONFile<LowDBData>(format({}, this.Options.Filename));
    this.db = new LowWithLodash<LowDBData>(this.adapter, {});
    await this.db.read();

    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public resolve() {
    super.resolve();
  }

  public async transaction(_qrOrCallback: QueryBuilder[] | TransactionCallback) {
    /**
     *
     * LOW DB have no transactions
     *
     *
     */
  }

  /**
   *
   * Retrieves information about specific DB table if exists. If table not exists returns null
   *
   * @param name - table name to retrieve info
   * @param _schema - optional schema name
   */
  public async tableInfo(_name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }
}
