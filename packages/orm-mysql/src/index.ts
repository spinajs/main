/* eslint-disable promise/no-promise-in-callback */
import { Injectable, NewInstance } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import { QueryContext, OrmDriver, IColumnDescriptor, QueryBuilder, TransactionCallback, TableExistsCompiler } from '@spinajs/orm';
import { SqlDriver } from '@spinajs/orm-sql';
import * as mysql from 'mysql2';
import { OkPacket } from 'mysql2';
import { MySqlTableExistsCompiler } from './compilers.js';
import { IIndexInfo, ITableColumnInfo } from './types.js';

@Injectable('orm-driver-mysql')
@NewInstance()
export class MySqlOrmDriver extends SqlDriver {
  protected Pool: mysql.Pool;
  protected _executionId = 0;

  public execute(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const tName = `query-${this._executionId++}`;
    this.Log.timeStart(`query-${tName}`);

    return new Promise((resolve, reject) => {
      this.Pool.query(stmt, params, function (err, results) {
        if (err) {
          reject(err);
        } else {
          switch (context) {
            case QueryContext.Update:
            case QueryContext.Delete:
              resolve({
                RowsAffected: (results as any as OkPacket).affectedRows,
              });
              break;
            case QueryContext.Insert:
              resolve({ LastInsertId: (results as any as OkPacket).insertId, RowsAffected: (results as any as OkPacket).affectedRows });
              break;
            default:
              resolve(results);
              break;
          }
        }
      });
    })
      .then((val) => {
        const tDiff = this.Log.timeEnd(`query-${tName}`);

        void this.Log.write({
          Level: LogLevel.Trace,
          Variables: {
            error: null,
            message: `Executed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
            logger: this.Log.Name,
            level: 'TRACE',
            duration: tDiff,
          },
        });

        return val;
      })
      .catch((err) => {
        const tDiff = this.Log.timeEnd(`query-${tName}`);

        void this.Log.write({
          Level: LogLevel.Error,
          Variables: {
            error: err,
            message: `Failed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
            logger: this.Log.Name,
            level: 'Error',
            duration: tDiff,
          },
        });

        throw err;
      });
  }

  public resolve() {
    super.resolve();

    this.Container.register(MySqlTableExistsCompiler).as(TableExistsCompiler);
  }

  public async ping(): Promise<boolean> {
    try {
      await this.execute('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
  }
  public connect(): Promise<OrmDriver> {
    this.Pool = mysql.createPool({
      host: this.Options.Host,
      user: this.Options.User,
      password: this.Options.Password,
      port: this.Options.Port,
      database: this.Options.Database,
      waitForConnections: true,
      connectionLimit: this.Options.PoolLimit,
      queueLimit: 0,
    });

    return Promise.resolve(this);
  }
  public disconnect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.Pool.end((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(this);
        }
      });
    });
  }
  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const tblInfo = (await this.execute(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? ${schema ? 'AND TABLE_SCHEMA=?' : ''} `, schema ? [name, schema] : [name], QueryContext.Select)) as ITableColumnInfo;
    const indexInfo = (await this.execute(`SHOW INDEXES FROM ${name}`, [], QueryContext.Select)) as IIndexInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    return tblInfo.map((r: ITableColumnInfo) => {
      const isPrimary = indexInfo.find((c) => c.Key_name === 'PRIMARY' && c.Column_name === r.COLUMN_NAME) !== undefined;
      const sUnique = indexInfo.find((c) => c.Non_unique === 0 && c.Column_name === r.COLUMN_NAME) !== undefined;
      return {
        Type: r.DATA_TYPE,
        MaxLength: -1,
        Comment: '',
        DefaultValue: r.COLUMN_DEFAULT,
        NativeType: r.DATA_TYPE,
        Unsigned: false,
        Nullable: r.IS_NULLABLE === 'YES',
        PrimaryKey: isPrimary,
        Uuid: false,
        Ignore: false,

        // simply assumpt that integer pkeys are autoincement / auto fill  by default
        AutoIncrement: isPrimary && r.DATA_TYPE === 'int',
        Name: r.COLUMN_NAME,
        Converter: null,
        Schema: schema ? schema : this.Options.Database,
        Unique: sUnique,
      };
    });
  }

  // todo fix transactions
  public transaction(queryOrCallback?: QueryBuilder<any>[] | TransactionCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      this.Pool.getConnection((err, connection) => {
        if (err) {
          reject(err);
        } else {
          connection.beginTransaction((err) => {
            if (err) {
              reject(err);
            } else {
              if (Array.isArray(queryOrCallback)) {
                Promise.all(queryOrCallback)
                  .then(() => {
                    resolve();
                    return;
                  })
                  .catch((err) => {
                    reject(err);
                  });
              } else {
                queryOrCallback(this)
                  .then(() => {
                    resolve();
                    return;
                  })
                  .catch((err) => {
                    reject(err);
                  });
              }
            }
          });
        }
      });
    });
  }
}
