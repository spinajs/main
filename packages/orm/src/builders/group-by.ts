import { NewInstance } from '@spinajs/di';
import type { Container } from '@spinajs/di';
import type { IGroupByBuilder } from '../interfaces.js';
import { GroupByStatement } from '../statements.js';
import type { IQueryStatement } from '../statements.js';
import type { RawQuery } from './raw.js';

@NewInstance()
export class GroupByBuilder implements IGroupByBuilder {
  protected _container!: Container;
  protected _groupStatements: IQueryStatement[] = [];

  public get GroupStatements(): IQueryStatement[] {
    return this._groupStatements;
  }

  public clearGroupBy(): this {
    this._groupStatements = [];
    return this;
  }

  public groupBy(expression: string | RawQuery): this {
    this._groupStatements.push(this._container.resolve<GroupByStatement>(GroupByStatement, [expression]));

    return this;
  }
}
