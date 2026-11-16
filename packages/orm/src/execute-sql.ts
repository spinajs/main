import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Builder } from './builders.js';
import type { OrmDriver } from './driver.js';
import { QueryContext, type ICompilerOutput, type SqlFragment } from './interfaces.js';
import { Orm } from './orm.js';

/** A fragment run as a select: no model and no hydration, so the rows are what the driver returns. */
class SqlFragmentQuery<R> extends Builder<R[]> {
  constructor(
    driver: OrmDriver,
    private readonly fragment: SqlFragment<R>,
  ) {
    super(driver.Container, driver);
    this.QueryContext = QueryContext.Select;
    this._asRaw = true;
  }

  public toDB(): ICompilerOutput {
    return { expression: this.fragment.sql, bindings: [...this.fragment.bindings] };
  }
}

/** Runs a `sql` fragment on a connection (default `'default'`) and returns its rows, typed by `sql<R>`. */
export async function executeSql<R>(fragment: SqlFragment<R>, options: { connection?: string } = {}): Promise<R[]> {
  const name = options.connection ?? 'default';
  const driver = DI.get(Orm)?.Connections.get(name);
  if (!driver) {
    throw new InvalidOperation(`executeSql: connection ${name} does not exist`);
  }
  return new SqlFragmentQuery(driver, fragment).execute();
}
