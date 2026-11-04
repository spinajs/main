import { Container, NewInstance } from '@spinajs/di';
import { IGroupByBuilder } from '../interfaces.js';
import { IQueryStatement, GroupByStatement } from '../statements.js';
import { RawQuery } from './raw.js';

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
