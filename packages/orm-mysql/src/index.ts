/* eslint-disable promise/no-promise-in-callback */
import { Injectable, NewInstance } from '@spinajs/di';
// No LogLevel import: master moved per-query timing out of every driver and into a single
// `Perf.measure('orm.query', ...)` around SqlDriver.execute, so duplicating it here would
// emit the same query twice. QueryBuilder / TransactionCallback / ITransaction are gone with
// the old `{ commit, rollback }` transaction shape this branch replaced. ConnectionState /
// IPoolMetrics are orm-infra's connection-resilience + pool-telemetry work.
import { QueryContext, OrmDriver, IColumnDescriptor, TableExistsCompiler, OrmException, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ConnectionState, IPoolMetrics, InSetStatement, IdentifierQuoter, OnDuplicateQueryCompiler, ColumnQueryCompiler, AlterColumnQueryCompiler, AlterTableQueryCompiler, TableCloneQueryCompiler, LimitQueryCompiler, TruncateTableQueryCompiler, RecursiveQueryCompiler, DefaultValueBuilder, DropEventQueryCompiler, EventQueryCompiler, TableHistoryQueryCompiler } from '@spinajs/orm';
import { BacktickIdentifierQuoter, SqlAlterColumnQueryCompiler, SqlAlterTableQueryCompiler, SqlColumnQueryCompiler, SqlDefaultValueBuilder, SqlDropEventQueryCompiler, SqlEventQueryCompiler, SqlLimitQueryCompiler, SqlOnDuplicateQueryCompiler, SqlTableCloneQueryCompiler, SqlTableHistoryQueryCompiler, SqlTruncateTableQueryCompiler, SqlWithRecursiveCompiler, escapeIdentifier, SqlDriver } from '@spinajs/orm-sql';
import * as mysql from 'mysql2';
import { OkPacket, PoolConnection, PoolOptions } from 'mysql2';
import { MySqlTableExistsCompiler } from './compilers.js';
import { MySqlInSetStatement } from './statements.js';
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
  // `_executionId` went with the per-driver query timing master centralised.
  // `TransactionStorage` is no longer declared here either — it moved up to OrmDriver so
  // ambient-connection propagation is part of the contract rather than a MySQL detail.

  /**
   * MySQL/InnoDB honours all four standard levels.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

  /**
   * DECIMAL/NUMERIC wraca z mysql2 jako STRING, nie number: parsuje je przez
   * readLengthCodedString dopoki `decimalNumbers` nie jest wlaczone (patrz connect() nizej -
   * domyslnie nie jest i wlaczac nie warto, powyzej 2^53 tracimy dokladnosc, ktora DECIMAL
   * ma wlasnie chronic). Zaden konwerter po drodze tego nie zmienia, wiec schemat ODPOWIEDZI
   * musi mowic to samo co runtime, inaczej walidacja u klienta wywala sie na kazdym wierszu.
   *
   * Deklarowane tutaj, a nie we wspolnej mapie @spinajs/orm, bo to fakt o TYM sterowniku:
   * tedious i sqlite oddaja DECIMAL jako number. Dotyczy wylacznie odczytu - w zadaniu
   * (`@Body()`) DECIMAL zostaje numerem, jak bylo.
   */
  public readonly ResponseSchemaTypes: Readonly<Record<string, unknown>> = {
    decimal: { type: 'string' },
    newdecimal: { type: 'string' },
    numeric: { type: 'string' },
  };

  public executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    // Reads and writes are both retried: `withReconnect` only re-runs on transport failures,
    // where the statement provably never reached the server.
    return this.withReconnect(() => this._executeOnDbOnce(stmt, params, context));
  }

  /**
   * True when the error means the transport died rather than the statement being wrong.
   */
  protected isRetryableError(err: unknown): boolean {
    // Inside a transaction the connection carried uncommitted state. Reconnecting and replaying
    // one statement would silently apply it OUTSIDE the transaction, so the error must surface.
    if (this.TransactionStorage.getStore()) {
      return false;
    }

    if (super.isRetryableError(err)) {
      return true;
    }

    // mysql2 marks connection-level failures fatal; a fatal error means the connection is gone
    // regardless of which code came with it.
    let current: any = err;
    let depth = 0;
    while (current && depth < 5) {
      if (current.fatal === true) {
        return true;
      }
      current = current.inner ?? current.cause;
      depth++;
    }

    return false;
  }

  protected _executeOnDbOnce(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const self = this;

    // Check if we're inside a transaction context and use that connection.
    // The context comes from the base driver, so `connection` is typed loosely there; only
    // this driver's `_begin` ever populates it, and it always puts a PoolConnection in.
    const txContext = this.TransactionStorage.getStore() as IMySqlTransactionContext | undefined;

    return new Promise((resolve, reject) => {
      const fail = (err: unknown) =>
        reject(
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

      const run = (queryable: mysql.Pool | PoolConnection, done: () => void) => {
        try {
          queryable.query(stmt, params, function (err, results) {
            done();

            if (err) {
              return fail(err);
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
        } catch (err) {
          // A synchronous throw would otherwise strand the connection outside the pool.
          done();
          fail(err);
        }
      };

      if (txContext?.connection) {
        // A transaction owns its connection for its whole lifetime — releasing it after one
        // statement would hand the rest of the transaction to a different connection.
        run(txContext.connection, () => undefined);
        return;
      }

      // Acquiring is the part that queues when the pool is saturated, so it is the part worth
      // timing. Taking the connection explicitly, instead of letting `Pool.query` do it out of
      // sight, is what makes `orm_pool_acquire_seconds` a real number instead of always zero.
      const acquireStart = process.hrtime.bigint();

      this.Pool.getConnection((err, connection) => {
        const seconds = Number(process.hrtime.bigint() - acquireStart) / 1e9;
        this.observeAcquireSeconds(seconds);

        if (err) {
          fail(err);
          return;
        }

        let released = false;
        run(connection, () => {
          if (released) {
            return;
          }
          released = true;
          connection.release();
        });
      });
    });
  }

  public supportedFeatures(): ISupportedFeature {
    // insertIdIsFirstOfBatch: a multi-row `INSERT ... VALUES` is a *simple insert* to InnoDB
    // ( row count known before execution ), so it reserves one contiguous block of
    // auto-increment values and LAST_INSERT_ID() reports the first of them. True even under
    // innodb_autoinc_lock_mode = 2, the MySQL 8 default.
    return { events: true, insertReturning: false, insertIdIsFirstOfBatch: true };
  }

  public resolve() {
    super.resolve();

    this.Container.register(MySqlTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(MysqlServerResponseMapper).as(ServerResponseMapper);

    // FIND_IN_SET moved here out of @spinajs/orm-sql, where every other driver
    // inherited it and produced SQL their database has no function for.
    this.Container.register(MySqlInSetStatement).as(InSetStatement);

    /**
     * The MySQL dialect, registered where it belongs.
     *
     * These classes are implemented in `@spinajs/orm-sql` and used to be registered by
     * its `SqlDriver` — so every driver that did not override them inherited MySQL's
     * SQL under a neutral class name. They emit `ON DUPLICATE KEY UPDATE`,
     * `AUTO_INCREMENT`, `CHANGE COLUMN`, `CREATE EVENT`, MySQL trigger syntax and
     * `CURRENT_DATE()`; MySQL is the database that understands all of it.
     */
    this.Container.register(BacktickIdentifierQuoter).as(IdentifierQuoter);
    this.Container.register(SqlOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqlColumnQueryCompiler).as(ColumnQueryCompiler);
    this.Container.register(SqlAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
    this.Container.register(SqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
    this.Container.register(SqlTableCloneQueryCompiler).as(TableCloneQueryCompiler);
    this.Container.register(SqlLimitQueryCompiler).as(LimitQueryCompiler);
    this.Container.register(SqlTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);
    this.Container.register(SqlWithRecursiveCompiler).as(RecursiveQueryCompiler);
    this.Container.register(SqlDefaultValueBuilder).as(DefaultValueBuilder);
    this.Container.register(SqlDropEventQueryCompiler).as(DropEventQueryCompiler);
    this.Container.register(SqlEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(SqlTableHistoryQueryCompiler).as(TableHistoryQueryCompiler);
  }

  /**
   * mysql2 keeps its pool bookkeeping on the internal `_allConnections` / `_freeConnections` /
   * `_connectionQueue` lists. They are not public API, so every read is guarded — a mysql2
   * upgrade that renames them degrades to zeros rather than crashing the health check.
   */
  public poolMetrics(): IPoolMetrics {
    const pool = this.Pool as any;

    const size = pool?._allConnections?.length ?? 0;
    const free = pool?._freeConnections?.length ?? 0;

    return {
      Size: size,
      InUse: Math.max(size - free, 0),
      Waiting: pool?._connectionQueue?.length ?? 0,
    };
  }

  public async ping(): Promise<boolean> {
    try {
      // deliberately bypasses `withReconnect` — a health probe that reconnects on its own
      // would turn one dead connection into a reconnect storm on every tick.
      await this._executeOnDbOnce('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
  }

  public connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      try {
        const pool = this.resolvedPoolOptions();

        this.Pool = mysql.createPool({
          host: this.Options.Host,
          user: this.Options.User,
          password: this.Options.Password,
          port: this.Options.Port,
          database: this.Options.Database,
          waitForConnections: true,
          connectionLimit: pool.Max,
          // mysql2's `maxIdle` is a CEILING on idle connections, not a floor, and it never
          // pre-warms the pool — so there is no direct equivalent of `Pool.Min`. Passing Min
          // straight through would set maxIdle to 0 by default and make mysql2 destroy every
          // released connection, i.e. disable pooling. Instead: an explicit Min becomes the
          // number of connections we let sit idle; Min = 0 keeps mysql2's own default (Max).
          maxIdle: pool.Min > 0 ? pool.Min : pool.Max,
          idleTimeout: pool.IdleTimeout,
          queueLimit: 0,
          // `decimalNumbers` zostaje WYLACZONE (domyslka mysql2): DECIMAL/NEWDECIMAL wraca
          // jako string, bo powyzej 2^53 float gubi dokladnosc, ktorej DECIMAL wlasnie ma
          // pilnowac. Kto to wlaczy, musi zmienic tez `ResponseSchemaTypes` na gorze tej
          // klasy - inaczej OpenAPI zacznie klamac o typie i walidacja odpowiedzi u klienta
          // poleci na kazdym wierszu.
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
          this.setState(ConnectionState.Connected);
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
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);

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

    // ORDER BY ORDINAL_POSITION is not decoration. Without it MySQL is free to return the rows
    // in any order — and does: the same table came back as (Code, TenantId) in one run and
    // (TenantId, Code) in the next. Column order is part of what a table descriptor means, so
    // it has to be the table's own order, not whatever the optimizer produced this time.
    const tblInfo = (await this.executeOnDb(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=? ORDER BY ORDINAL_POSITION`, [name, dbSchema], QueryContext.Select)) as ITableColumnInfo;
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

          const pool = this.resolvedPoolOptions();

          this.Pool = mysql.createPool({
            host: 'localhost', // we tunnel via ssh so we use localhost
            user: this.Options.User,
            password: this.Options.Password,
            port: this.Options.Port,
            database: this.Options.Database,
            waitForConnections: true,
            connectionLimit: pool.Max,
            // see MySqlOrmDriver.connect — `maxIdle` is a ceiling, so Min = 0 must not reach it
            maxIdle: pool.Min > 0 ? pool.Min : pool.Max,
            idleTimeout: pool.IdleTimeout,
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
        privateKey: fs.readFileSync(this.Options.SSH!.PrivateKey),
      });
    });
  }
}
