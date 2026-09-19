import { Autoinject, Container, Inject, NewInstance } from '@spinajs/di';
import { InvalidOperation, MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewCompiler, CreateViewQueryBuilder, ICompilerOutput, IdentifierQuoter, LiteralQuoter, RawQuery, TableAliasCompiler } from '@spinajs/orm';
import { inlineBindings } from './literals.js';

/**
 * Portable core only. Every optional clause throws here and a driver overrides the hook of
 * each clause its engine has, so a clause nobody ported fails instead of reaching the engine
 * as another dialect's SQL.
 */
@NewInstance()
@Inject(Container)
export class SqlCreateViewQueryCompiler extends CreateViewCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  @Autoinject(LiteralQuoter)
  public Literals: LiteralQuoter;

  protected Engine = 'this database engine';

  constructor(protected container: Container, protected builder: CreateViewQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const parts = ['CREATE', this._replace(), this._temporary(), this._prefixOptions(), 'VIEW', this._ifNotExists(), this._name(), this._columns(), this._withOptions(), 'AS', this._body(), this._checkOption()];

    return {
      bindings: [],
      expression: parts.filter((part) => part !== '').join(' '),
    };
  }

  protected unsupported(clause: string): never {
    throw new MethodNotImplemented(`${this.Engine} does not support ${clause} on CREATE VIEW`);
  }

  protected _replace(): string {
    return this.builder.Replace ? this.unsupported('OR REPLACE') : '';
  }

  protected _temporary(): string {
    return this.builder.Temporary ? this.unsupported('TEMPORARY') : '';
  }

  /** Clauses between CREATE and VIEW */
  protected _prefixOptions(): string {
    if (this.builder.Algorithm) {
      this.unsupported('ALGORITHM');
    }

    if (this.builder.Security) {
      this.unsupported('SQL SECURITY');
    }

    return '';
  }

  protected _ifNotExists(): string {
    return this.builder.IfNotExists ? this.unsupported('IF NOT EXISTS') : '';
  }

  protected _name(): string {
    return this.container.resolve(TableAliasCompiler).compile(this.builder);
  }

  protected _columns(): string {
    return this.builder.Columns.length === 0 ? '' : `(${this.builder.Columns.map((column) => this.Quoter.quote(column)).join(',')})`;
  }

  /** Clauses between the column list and AS */
  protected _withOptions(): string {
    return '';
  }

  protected _body(): string {
    const body = this.builder.Body;

    if (!body) {
      throw new InvalidOperation(`view ${this.builder.Table} has no body, call as() first`);
    }

    if (body instanceof RawQuery) {
      return inlineBindings(body.Query, body.Bindings, this.Literals);
    }

    const compiled = body.toDB();
    return inlineBindings(compiled.expression!, compiled.bindings!, this.Literals);
  }

  protected _checkOption(): string {
    return this.builder.CheckOption ? this.unsupported('CHECK OPTION') : '';
  }

  /** The full `WITH [CASCADED | LOCAL] CHECK OPTION`, for the dialects that have every form. */
  protected checkOptionSql(): string {
    const option = this.builder.CheckOption;

    if (!option) {
      return '';
    }

    return option === true ? 'WITH CHECK OPTION' : `WITH ${option} CHECK OPTION`;
  }
}
