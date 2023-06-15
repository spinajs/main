import { Injectable, NewInstance } from '@spinajs/di';
import { format } from '@spinajs/configuration';
import { IColumnDescriptor, OrmDriver, QueryBuilder, TransactionCallback, Builder } from '@spinajs/orm';
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import lodash from 'lodash'

class LowWithLodash<T> extends Low<T> {
  chain: lodash.ExpChain<this['data']> = lodash.chain(this).get('data')
}

@Injectable('orm-driver-lowdb')
@NewInstance()
export class SqliteOrmDriver extends OrmDriver {
  protected executionId = 0;

  protected adapter: JSONFile<unknown>
  protected db: LowWithLodash<unknown>;

  public execute(_builder: Builder<any>): Promise<unknown> {

    return Promise.resolve(true);
    // const queryParams = params ?? [];


    // const tName = `query-${this.executionId++}`;
    // this.Log.timeStart(`query-${tName}`);

    // return new Promise((resolve, reject) => {
    //   switch (queryContext) {
    //     case QueryContext.Update:
    //     case QueryContext.Delete:

    //       break;

    //     case QueryContext.Select:


    //       break;
    //     case QueryContext.Insert:

    //       break;
    //     case QueryContext.Schema:
    //     case QueryContext.Transaction:
    //     default:

    //       break;
    //   }
    // })
    //   .then((val) => {
    //     const tDiff = this.Log.timeEnd(`query-${tName}`);

    //     void this.Log.write({
    //       Level: LogLevel.Trace,
    //       Variables: {
    //         error: null,
    //         message: `Executed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
    //         logger: this.Log.Name,
    //         level: 'TRACE',
    //         duration: tDiff,
    //       },
    //     });

    //     return val;
    //   })
    //   .catch((err) => {
    //     const tDiff = this.Log.timeEnd(`query-${tName}`);

    //     void this.Log.write({
    //       Level: LogLevel.Error,
    //       Variables: {
    //         error: err,
    //         message: `Failed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
    //         logger: this.Log.Name,
    //         level: 'Error',
    //         duration: tDiff,
    //       },
    //     });

    //     throw err;
    //   });
  }

  public async ping(): Promise<boolean> {
    return this.db !== null && this.db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    this.adapter = new JSONFile<unknown>(format({}, this.Options.Filename));
    this.db = new LowWithLodash<unknown>(this.adapter, {});
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
