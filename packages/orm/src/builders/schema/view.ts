import { Container, NewInstance } from '@spinajs/di';
import { QueryContext, DropViewCompiler, CreateViewCompiler } from '../../interfaces.js';
import type { ICompilerOutput } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import type { SchemaTouch } from '../../schema-touches.js';
import { assertOneOf } from '../internal.js';
import type { RawQuery } from '../raw.js';
import { QueryBuilder } from '../base.js';
import { SelectQueryBuilder } from '../select.js';

@NewInstance()
export class DropViewQueryBuilder extends QueryBuilder {
  public Exists: boolean;

  constructor(container: Container, driver: OrmDriver, name: string, database?: string) {
    super(container, driver, undefined);

    this.setTable(name);

    if (database) {
      this.database(database);
    }

    this.Exists = false;
    this.QueryContext = QueryContext.Schema;
  }

  public ifExists() {
    this.Exists = true;
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropViewCompiler>(DropViewCompiler, [this]).compile();
  }
}

export type ViewAlgorithm = 'UNDEFINED' | 'MERGE' | 'TEMPTABLE';

export type ViewSecurity = 'DEFINER' | 'INVOKER';

export type ViewCheckOption = 'CASCADED' | 'LOCAL';

const VIEW_ALGORITHMS: readonly string[] = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];

const VIEW_SECURITY: readonly string[] = ['DEFINER', 'INVOKER'];

const VIEW_CHECK_OPTIONS: readonly string[] = ['CASCADED', 'LOCAL'];

/**
 * CREATE VIEW. Which optional clauses exist is the dialect's business: a driver's compiler
 * throws MethodNotImplemented for a clause its engine does not have.
 */
@NewInstance()
export class CreateViewQueryBuilder extends QueryBuilder {
  public Replace = false;
  public IfNotExists = false;
  public Temporary = false;
  public Columns: string[] = [];
  public Algorithm?: ViewAlgorithm;
  public Security?: ViewSecurity;

  /** `true` is the plain `WITH CHECK OPTION` */
  public CheckOption?: ViewCheckOption | true;

  public Body?: SelectQueryBuilder | RawQuery;

  constructor(container: Container, driver: OrmDriver, name: string, database?: string) {
    super(container, driver, undefined);

    this.setTable(name);

    if (database) {
      this.database(database);
    }

    this.QueryContext = QueryContext.Schema;
  }

  public orReplace() {
    this.Replace = true;
    return this;
  }

  public ifNotExists() {
    this.IfNotExists = true;
    return this;
  }

  public temporary() {
    this.Temporary = true;
    return this;
  }

  public columns(names: string[]) {
    this.Columns = names;
    return this;
  }

  public algorithm(algorithm: ViewAlgorithm) {
    this.Algorithm = assertOneOf(algorithm, VIEW_ALGORITHMS, 'view algorithm');
    return this;
  }

  public security(security: ViewSecurity) {
    this.Security = assertOneOf(security, VIEW_SECURITY, 'view security');
    return this;
  }

  public checkOption(option?: ViewCheckOption) {
    this.CheckOption = option ? assertOneOf(option, VIEW_CHECK_OPTIONS, 'view check option') : true;
    return this;
  }

  /**
   * @param body - callback receiving a fresh select builder, a ready select builder, or raw SQL
   */
  public as(body: ((select: SelectQueryBuilder) => void) | SelectQueryBuilder | RawQuery) {
    if (typeof body === 'function') {
      const select = new SelectQueryBuilder(this._container, this._driver);
      body(select);
      this.Body = select;
    } else {
      this.Body = body;
    }

    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<CreateViewCompiler>(CreateViewCompiler, [this]).compile();
  }
}
