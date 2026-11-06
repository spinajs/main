import { Container, NewInstance, Constructor } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IColumnsBuilder } from '../interfaces.js';
import { ColumnStatement, IQueryStatement, ColumnRawStatement } from '../statements.js';
import { ModelBase } from '../model.js';
import { extractModelDescriptor } from '../descriptor.js';
import { RawQuery } from './raw.js';

@NewInstance()
export class ColumnsBuilder implements IColumnsBuilder {
  protected _container: Container;
  protected _columns: IQueryStatement[];
  protected _tableAlias: string;
  protected _model?: Constructor<ModelBase>;

  constructor() {
    this._columns = [];
  }

  /**
   * Clears all select clauses from the query.
   *
   * @example
   *
   * query.columns()
   *
   */
  public clearColumns() {
    this._columns = [];

    return this;
  }

  public columns(names: string[]) {
    const descriptor = extractModelDescriptor(this._model);
    this._columns = names.map((n) => {
      return this._container.resolve<ColumnStatement>(ColumnStatement, [n, null, this._tableAlias, descriptor?.Columns.filter(c => !c.Virtual).find((c) => c.Name === n)]);
    });

    return this;
  }

  public select(column: string | RawQuery | Map<string, string>, alias?: string) {
    const descriptor = extractModelDescriptor(this._model);

    if (column instanceof Map) {
      column.forEach((alias, colName) => {
        const colDesc = descriptor?.Columns.find((c) => c.Name === colName && !c.Virtual);
        if (colDesc) {
          this._columns.push(this._container.resolve<ColumnStatement>(ColumnStatement, [colName, alias, this._tableAlias, colDesc]));
        }
      });
    }

    else if (column instanceof RawQuery) {
      this._columns.push(this._container.resolve<ColumnRawStatement>(ColumnRawStatement, [column, null, this._tableAlias]));
    }
    else if (column === '*') {
      // special case for SELECT *
      this._columns.push(this._container.resolve(ColumnStatement, [column, alias, this._tableAlias, null]));
    }
    // if query has model associated try to extract column info from descriptor
    else if (descriptor) {
      const colDesc = descriptor?.Columns.find((c) => c.Name === column && !c.Virtual);
      if (colDesc) {
        this._columns.push(this._container.resolve<ColumnStatement>(ColumnStatement, [column, alias, this._tableAlias, colDesc]));
      } else {
        throw new InvalidArgument(`Column ${column} does not exist on model ${this._model?.name}`);
      }
    }
    // if no model associated just add column as is
    else {
      this._columns.push(this._container.resolve<ColumnStatement>(ColumnStatement, [column, alias, this._tableAlias, null]));
    }

    return this;
  }

  public getColumns() {
    return this._columns;
  }
}
