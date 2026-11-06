import { Container, Inject, NewInstance } from '@spinajs/di';
import { ICompilerOutput, QueryContext, IndexQueryCompiler } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import { SchemaTouch } from '../../schema-touches.js';
import { Builder } from '../base.js';

@NewInstance()
@Inject(Container)
export class IndexQueryBuilder extends Builder {
  public Name: string;
  public Unique: boolean;
  public Table: string;
  public Columns: string[];
  public Drop: boolean;

  constructor(container: Container, driver: OrmDriver) {
    super(container, driver);

    this.QueryContext = QueryContext.Schema;
  }

  public name(name: string) {
    this.Name = name;

    return this;
  }

  public unique() {
    this.Unique = true;

    return this;
  }

  public table(name: string) {
    this.Table = name;

    return this;
  }

  public columns(colNames: string[]) {
    this.Columns = colNames;

    return this;
  }

  /** Drops the index named by `name()` on `table()` instead of creating it. */
  public drop() {
    this.Drop = true;

    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<IndexQueryCompiler>(IndexQueryCompiler, [this]).compile();
  }
}
