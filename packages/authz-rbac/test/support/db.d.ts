import { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
export type DbKind = 'sqlite' | 'postgres';
export declare const DB_KINDS: DbKind[];
export declare const PG_SERVER: {
    Host: string;
    Port: number;
    User: string;
    Password: string;
    Database: string;
};
export interface TestDb {
    kind: DbKind;
    orm: Orm;
    /** The child container the Orm was resolved in; resolve stores from it. */
    container: IContainer;
    /** The connection the authz-rbac migrations and stores use (`'default'`). */
    driver: OrmDriver;
    /** Postgres only: the database created for this run. */
    database?: string;
    /** With `second: true`: another SQLite `:memory:` connection, without migrations. */
    second?: OrmDriver;
    dispose(): Promise<void>;
}
export interface BootOptions {
    /** `Migration.OnStartup` of the connection; default true. */
    migrate?: boolean;
    /** Also boot a second connection (`TestDb.second`). */
    second?: boolean;
}
/** Runs plain SQL (`?` placeholders); `executeOnDb` lives on the SQL drivers, not on `OrmDriver`. */
export declare function rawQuery(driver: OrmDriver, sql: string, bindings?: unknown[], context?: QueryContext): Promise<any>;
/**
 * Throws when Postgres is unreachable and `L2_REQUIRE_PG=1`; otherwise skips the calling suite.
 */
export declare function requirePostgres(ctx: Mocha.Context): Promise<void>;
export declare function createPgDatabase(suite: string): Promise<string>;
export declare function dropPgDatabase(name: string): Promise<void>;
/**
 * Call from a `before()` hook. For Postgres, skips the suite (see {@link requirePostgres}) and
 * creates a database named after `suite`, dropped again by `dispose()`.
 */
export declare function bootDb(ctx: Mocha.Context, kind: DbKind, suite: string, options?: BootOptions): Promise<TestDb>;
//# sourceMappingURL=db.d.ts.map