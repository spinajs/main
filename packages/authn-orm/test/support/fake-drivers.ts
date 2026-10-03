/** MySQL and MSSQL drivers that record the SQL they are given instead of running it: no server needed. */
import { DI } from '@spinajs/di';
import { IColumnDescriptor, OrmDriver, QueryContext } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

export interface Executed {
  stmt: string;
  params: unknown[];
  context: QueryContext;
}

export type Respond = (stmt: string, context: QueryContext) => unknown;

export interface Recording {
  executed: Executed[];
  respond: Respond;
}

export class FakeMySql extends MySqlOrmDriver implements Recording {
  public executed: Executed[] = [];
  public respond: Respond = () => [];

  public async executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<any> {
    this.executed.push({ stmt, params, context });
    return this.respond(stmt, context);
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public tableInfo(): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }
}

export class FakeMsSql extends MsSqlOrmDriver implements Recording {
  public executed: Executed[] = [];
  public respond: Respond = () => [];

  public async executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<any> {
    this.executed.push({ stmt, params, context });
    return this.respond(stmt, context);
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public tableInfo(): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }
}

export const sql = (e: Executed): string => e.stmt.replace(/\s+/g, ' ').trim();

export async function fake(type: typeof FakeMySql | typeof FakeMsSql, name: string): Promise<OrmDriver & Recording> {
  return (await DI.child().resolve<OrmDriver>(type, [{ Name: name, Driver: name, Database: 'test' }])) as OrmDriver & Recording;
}
