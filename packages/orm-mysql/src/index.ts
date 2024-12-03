/* eslint-disable promise/no-promise-in-callback */
import { Injectable, NewInstance } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import { QueryContext, OrmDriver, IColumnDescriptor, QueryBuilder, TransactionCallback, TableExistsCompiler, OrmException, ServerResponseMapper, ISupportedFeature } from '@spinajs/orm';
import { SqlDriver } from '@spinajs/orm-sql';
import * as mysql from 'mysql2';
import { OkPacket, PoolOptions } from 'mysql2';
import { MySqlTableExistsCompiler } from './compilers.js';
import { IIndexInfo, ITableColumnInfo, ITableTypeInfo } from './types.js';
import { Client as SSHClient } from 'ssh2';
import fs from 'fs';

export class MysqlServerResponseMapper extends ServerResponseMapper {
  public read(data: any) {
    return {
      LastInsertId: data.insertId,
    };
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class MySqlOrmDriver extends SqlDriver {
  protected Pool: mysql.Pool;
  protected _executionId = 0;

  public executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
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

  public supportedFeatures(): ISupportedFeature {
    return { events: true };
  }

  public resolve() {
    super.resolve();

    this.Container.register(MySqlTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(MysqlServerResponseMapper).as(ServerResponseMapper);
  }

  public async ping(): Promise<boolean> {
    try {
      await this.executeOnDb('SELECT 1', [], QueryContext.Select);
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
    const tblInfo = (await this.executeOnDb(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? ${schema ? 'AND TABLE_SCHEMA=?' : ''} `, schema ? [name, schema] : [name], QueryContext.Select)) as ITableColumnInfo;
    const isView = (await this.executeOnDb(`SHOW FULL TABLES where \`Tables_in_${schema}\`='${name}'`, [], QueryContext.Select)) as ITableTypeInfo[];
    let indexInfo: IIndexInfo[] = [];

    if (isView && isView[0].Table_type === 'VIEW') {
      this.Log.trace(`Table ${schema}.${name} is a VIEW and dont have indexes set.`);
    } else {
      indexInfo = (await this.executeOnDb(`SHOW INDEXES FROM ${name}`, [], QueryContext.Select)) as IIndexInfo[];
    }

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
        IsForeignKey: false,
        ForeignKeyDescription: null,
        AutoIncrement: r.EXTRA.includes('auto_increment'),
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

@Injectable('orm-driver-mysql-ssh')
@NewInstance()
export class MySqlSSHOrmDriver extends MySqlOrmDriver {
  protected SshClient: SSHClient;

  public resolve() {
    super.resolve();

    if (!this.Options.SSH) {
      throw new OrmException(`SSH options are not set for MySqlSSHOrmDriver`);
    }

    if (!fs.existsSync(this.Options.SSH.PrivateKey)) {
      throw new OrmException(`SSH private key file ${this.Options.SSH.PrivateKey} does not exist`);
    }
  }

  public async disconnect() {
    await super.disconnect();

    if (this.SshClient) {
      this.SshClient.end();
    }

    return this;
  }

  public connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.SshClient = new SSHClient();

      this.SshClient.on('ready', () => {
        this.SshClient.forwardOut('127.0.0.1', 12345, this.Options.Host, this.Options.Port, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          this.Pool = mysql.createPool({
            host: 'localhost', // we tunnel via ssh so we use localhost
            user: this.Options.User,
            password: this.Options.Password,
            port: this.Options.Port,
            database: this.Options.Database,
            waitForConnections: true,
            connectionLimit: this.Options.PoolLimit,
            queueLimit: 0,
            stream: stream,
          } as PoolOptions);

          resolve(this);
        });
      });

      this.SshClient.on('error', (err) => {
        reject(err);
      });

      this.SshClient.connect({
        host: this.Options.SSH.Host,
        port: this.Options.SSH.Port,
        username: this.Options.SSH.User,
        privateKey: fs.readFileSync(this.Options.SSH.PrivateKey),
      });
    });
  }
}
