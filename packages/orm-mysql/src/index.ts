/* eslint-disable promise/no-promise-in-callback */
import { Injectable, NewInstance } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import { QueryContext, OrmDriver, IColumnDescriptor, TableExistsCompiler, OrmException, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions } from '@spinajs/orm';
import { escapeIdentifier, SqlDriver } from '@spinajs/orm-sql';
import * as mysql from 'mysql2';
import { OkPacket, PoolConnection, PoolOptions } from 'mysql2';
import { MySqlTableExistsCompiler } from './compilers.js';
import { IIndexInfo, ITableColumnInfo, ITableTypeInfo } from './types.js';
import { Client as SSHClient } from 'ssh2';
import fs from 'fs';

export interface IMySqlTransactionContext extends ITransactionContext {
  connection: PoolConnection;
}

export class MysqlServerResponseMapper extends ServerResponseMapper {
  public read(data: any) {
    // MySQL has no RETURNING; the identity value is all it reports.
    return {
      LastInsertId: data?.LastInsertId ?? 0,
      RowsAffected: data?.RowsAffected ?? 0,
      Returning: [] as any[],
    };
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class MySqlOrmDriver extends SqlDriver {
  protected Pool: mysql.Pool;
  protected _executionId = 0;

  /**
   * MySQL/InnoDB honours all four standard levels.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

  private getNextExecutionId(): number {
    this._executionId = (this._executionId + 1) % Number.MAX_SAFE_INTEGER;
    return this._executionId;
  }

  public executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const self = this;
    const tName = `query-${this.getNextExecutionId()}`;
    this.Log.timeStart(`query-${tName}`);

    // Check if we're inside a transaction context and use that connection.
    // The context comes from the base driver, so `connection` is typed loosely there; only
    // this driver's `_begin` ever populates it, and it always puts a PoolConnection in.
    const txContext = this.TransactionStorage.getStore() as IMySqlTransactionContext | undefined;
    const queryable: mysql.Pool | PoolConnection = txContext?.connection ?? this.Pool;

    return new Promise((resolve, reject) => {

      queryable.query(stmt, params, function (err, results) {
        if (err) {
          return reject(
            new OrmException(
              `Error executing orm command `,
              {
                Host: self.Options.Host,
                User: self.Options.User,
                Name: self.Options.Name,
              },
              stmt,
              params,
              err,
            ),
          );
        }

        switch (context) {
          case QueryContext.Update:
          case QueryContext.Delete:
            resolve({
              RowsAffected: (results as any as OkPacket).affectedRows,
            });
            break;
          case QueryContext.Insert:
          case QueryContext.Upsert:
            resolve({
              RowsAffected: (results as any as OkPacket).affectedRows,
              LastInsertId: (results as any as OkPacket).insertId,
              Returning: [],
            });
            break;
          default:
            resolve(results);
            break;
        }
      });
    })
      .then((val) => {
        const tDiff = this.Log.timeEnd(`query-${tName}`);

        void this.Log.write({
          Level: LogLevel.Trace,
          Variables: {
            error: undefined,
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
    return { events: true, insertReturning: false };
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
    return new Promise((resolve, reject) => {
      try {
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

        // Test the pool connection
        this.Pool.getConnection((err, connection) => {
          if (err) {
            // Clean up the pool if connection test fails
            this.Pool.end(() => {
              reject(err);
            });
            return;
          }

          // Release the test connection
          connection.release();
          resolve(this);
        });
      } catch (err) {
        // Clean up if pool creation fails
        if (this.Pool) {
          this.Pool.end(() => {
            reject(err);
          });
        } else {
          reject(err);
        }
      }
    });
  }

  public disconnect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      if (!this.Pool) {
        resolve(this);
        return;
      }

      this.Pool.end((err) => {
        if (err) {
          reject(err);
        } else {
          this.Pool = null as any;
          resolve(this);
        }
      });
    });
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const dbSchema = schema ?? this.Options.Database;

    if (!dbSchema) {
      throw new OrmException(`Cannot read table info for '${name}': no schema/database configured for this connection ( pass a schema or set Options.Database )`);
    }

    // backtick-quote an identifier, escaping embedded backticks by doubling them
    const escapeId = (id: string) => '`' + String(id).replace(/`/g, '``') + '`';

    const tblInfo = (await this.executeOnDb(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [name, dbSchema], QueryContext.Select)) as ITableColumnInfo;
    const isView = (await this.executeOnDb(`SHOW FULL TABLES FROM ${escapeId(dbSchema)} WHERE ${escapeId(`Tables_in_${dbSchema}`)}=?`, [name], QueryContext.Select)) as ITableTypeInfo[];
    let indexInfo: IIndexInfo[] = [];

    if (!isView || isView.length === 0) {
      throw new OrmException(`Table ${dbSchema}.${name} does not exist`);
    }

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      this.Log.trace(`Table ${dbSchema}.${name} does not have any columns.`);
      return null as any;
    }

    if (isView && isView[0].Table_type === 'VIEW') {
      this.Log.trace(`Table ${dbSchema}.${name} is a VIEW and dont have indexes set.`);
    } else {
      indexInfo = (await this.executeOnDb(`SHOW INDEXES FROM ${escapeId(name)}`, [], QueryContext.Select)) as IIndexInfo[];
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
        Virtual: false,
        ForeignKeyDescription: null as any,
        AutoIncrement: r.EXTRA.includes('auto_increment'),
        Name: r.COLUMN_NAME,
        Aggregate: false,
        Converter: null as any,
        Schema: schema ? schema : this.Options.Database,
        Unique: sUnique,
      };
    });
  }

  /**
   * Pulls the pooled connection out of a transaction context. The base class only ever hands
   * us contexts this driver's own `_begin` produced, so the cast is safe.
   */
  private txConnection(ctx: ITransactionContext): PoolConnection {
    return (ctx as IMySqlTransactionContext).connection;
  }

  /**
   * Runs a statement on the transaction's own connection, bypassing the ambient-context lookup
   * in `executeOnDb`. Transaction control statements must never land on a pooled connection
   * other than their own.
   */
  private runOnConnection(connection: PoolConnection, stmt: string): Promise<void> {
    return new Promise((resolve, reject) => {
      connection.query(stmt, (err) => (err ? reject(err) : resolve()));
    });
  }

  protected _begin(options?: ITransactionOptions): Promise<ITransactionContext> {
    return new Promise((resolve, reject) => {
      this.Pool.getConnection((err, connection) => {
        if (err) {
          reject(err);
          return;
        }

        const begin = () => {
          connection.beginTransaction((err) => {
            if (err) {
              connection.release();
              reject(err);
              return;
            }

            resolve({ connection, depth: 0 });
          });
        };

        if (options?.isolation) {
          // isolation levels are a fixed, validated enum — never caller-supplied free text
          this.runOnConnection(connection, `SET TRANSACTION ISOLATION LEVEL ${options.isolation}`).then(begin, (err) => {
            connection.release();
            reject(err);
          });
          return;
        }

        begin();
      });
    });
  }

  protected _commit(ctx: ITransactionContext): Promise<void> {
    return new Promise((resolve, reject) => {
      this.txConnection(ctx).commit((err) => (err ? reject(err) : resolve()));
    });
  }

  protected _rollback(ctx: ITransactionContext): Promise<void> {
    return new Promise((resolve, reject) => {
      this.txConnection(ctx).rollback((err?: unknown) => (err ? reject(err) : resolve()));
    });
  }

  // savepoint names cannot be bound parameters, so they are inlined through the identifier
  // escaper rather than passed as `?`
  protected _savepoint(ctx: ITransactionContext, name: string): Promise<void> {
    return this.runOnConnection(this.txConnection(ctx), `SAVEPOINT ${escapeIdentifier(name)}`);
  }

  protected _releaseSavepoint(ctx: ITransactionContext, name: string): Promise<void> {
    return this.runOnConnection(this.txConnection(ctx), `RELEASE SAVEPOINT ${escapeIdentifier(name)}`);
  }

  protected _rollbackToSavepoint(ctx: ITransactionContext, name: string): Promise<void> {
    return this.runOnConnection(this.txConnection(ctx), `ROLLBACK TO SAVEPOINT ${escapeIdentifier(name)}`);
  }

  protected async _dispose(ctx: ITransactionContext): Promise<void> {
    this.txConnection(ctx).release();
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
        this.SshClient.forwardOut('127.0.0.1', 12345, this.Options.Host!, this.Options.Port!, (err, stream) => {
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
        host: this.Options.SSH!.Host,
        port: this.Options.SSH!.Port,
        username: this.Options.SSH!.User,
        privateKey: fs.readFileSync(this.Options.SSH!.PrivateKey!),
      });
    });
  }
}
