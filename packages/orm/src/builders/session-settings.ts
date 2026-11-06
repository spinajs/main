import { Container, Inject, NewInstance } from '@spinajs/di';
import { ICompilerOutput, QueryContext, SessionSettingsQueryCompiler } from '../interfaces.js';
import type { OrmDriver } from '../driver.js';
import { QueryBuilder } from './base.js';

@NewInstance()
@Inject(Container)
export class SessionSettingsQueryBuilder extends QueryBuilder {
  constructor(
    container: Container,
    driver: OrmDriver,
    public readonly Settings: Readonly<Record<string, string>>,
  ) {
    super(container, driver);
    this.QueryContext = QueryContext.Transaction;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<SessionSettingsQueryCompiler>(SessionSettingsQueryCompiler, [this]).compile();
  }
}
