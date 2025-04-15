import { Log, Logger } from '@spinajs/log';
import { AsyncService, Injectable, NewInstance } from '@spinajs/di';
import { format } from '@spinajs/configuration';
import { IColumnDescriptor, OrmDriver, QueryBuilder, TransactionCallback, Builder, QueryContext, SqlOperator, Wrap, UpdateQueryBuilder, InsertQueryBuilder, DeleteQueryBuilder, WhereBuilder, ColumnStatement, ISupportedFeature } from '@spinajs/orm';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import _ from 'lodash';
import { WhereStatement } from '@spinajs/orm';
import { OrmException } from '@spinajs/orm';
import * as fs from 'fs';
import Path from 'path';
import { use } from 'typescript-mix';
import EventEmitter from 'events';

class LowWithLodash<T> extends Low<T> {
  chain: _.ExpChain<this['data']> = _.chain(this).get('data');
}

interface LowDBData {
  [key: string]: any[];
}

export interface LowdbDataSynchronizer extends EventEmitter {}

/**
 *  Lowdb can synchronzie db file from external source
 *  eg. download db from api
 */
export abstract class LowdbDataSynchronizer extends AsyncService {
  @use(EventEmitter)
  this: this;
}

interface ILowDbHttpSynchronizeOptions {
  Host: string;
  Port: number;
  Interval: number;
}

export class LowDBHttpSynchronizer extends LowdbDataSynchronizer {
  @Logger('low-db-synchronizer')
  protected log: Log;

  protected syncTimer: NodeJS.Timeout;

  constructor(protected Options: ILowDbHttpSynchronizeOptions, protected Driver: OrmDriver) {
    super();
  }

  public async resolve(): Promise<void> {
    this.syncTimer = setInterval(async () => {
      this.log.trace(`Synchronizing lowdb database...`);

      const dbFileName = format({}, this.Driver.Options.Filename);
      const stat = fs.statSync(dbFileName);

      const result = await fetch(this.Options.Host, {
        method: 'GET',
        headers: {
          'if-modified-since': stat.mtime.toISOString(),
        },
      });

      if (result.status === 304) {
        this.log.info(`Synchronization finished, not modified`);
        return;
      }

      if (result.status !== 200) {
        this.log.error(`Synchronization failed, status: ${result.status}`);
        return;
      }

      const js = await result.json();

      fs.writeFileSync(dbFileName, js, {
        encoding: 'utf-8',
      });

      this.log.success(`Synchronization finished, new data arrived`);

      this.emit('synchronized');
    }, this.Options.Interval);
  }

  public async dispose(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
  }
}

@Injectable('orm-driver-lowdb')
@NewInstance()
export class LowDBDriver extends OrmDriver {
  protected executionId = 0;

  protected adapter: JSONFile<LowDBData>;
  protected db: LowWithLodash<LowDBData>;
  protected dbSchema: any;

  public supportedFeatures(): ISupportedFeature {
    return {
      events: false,
    };
  }

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

    this.db.data[builder.Table] = this.db.data[builder.Table].filter((x) => {
      return _.every(data, (b) => !_.isEqual(x, b));
    });

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
    const dbFileName = format({}, this.Options.Filename);
    const path = Path.parse(dbFileName);
    const schemaFileName = format({}, Path.join(path.dir, `${path.name}.schema.json`));

    this.adapter = new JSONFile<LowDBData>(dbFileName);
    this.db = new LowWithLodash<LowDBData>(this.adapter, {});
    await this.db.read();

    if (!fs.existsSync(schemaFileName)) {
      this.Log.warn(`Schema file at ${schemaFileName} not exists. Lowdb will not be able to proper insert into DB`);
    } else {
      this.dbSchema = JSON.parse(fs.readFileSync(schemaFileName, 'utf-8'));
    }

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
