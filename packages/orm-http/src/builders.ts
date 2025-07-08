import { SelectQueryBuilder, SqlOperator } from '@spinajs/orm';
import { IFilter, IColumnFilter } from './interfaces.js';

/**
 * Extend where builder with  flter func old style ( by prototype )
 */
(SelectQueryBuilder.prototype as any).filter = function (this: SelectQueryBuilder<any>, filters?: IFilter[], filterColumns?: IColumnFilter<unknown>[]) {


  if (!filters || filters.length === 0) {
    return this;
  }

  const columns: IColumnFilter<unknown>[] = filterColumns ?? (this._model as any).filterColumns();
  filters.forEach((filter) => {

    if (!filter.Column) {
      throw new Error('Column is required');
    }

    if (!filter.Operator) {
      throw new Error('Operator is required');
    }

    const column = columns.find((c) => c.column === filter.Column);
    if (!column) {
      throw new Error(`Column ${filter.Column} is not filterable`);
    }

    if (column.query) {
      column.query(filter.Operator, filter.Value).call(this);
      return this;
    }


    // TODO: in futere add full expression tree support ( OR, AND, maybe nesting queries for relations, EXISTS maybe ?)
    switch (filter.Operator) {
      case 'eq':
        this.andWhere(filter.Column, SqlOperator.EQ, filter.Value);
        break;
      case 'neq':
        this.andWhere(filter.Column, SqlOperator.NOT, filter.Value);
        break;
      case 'gt':
        this.andWhere(filter.Column, SqlOperator.GT, filter.Value);
        break;
      case 'gte':
        this.andWhere(filter.Column, SqlOperator.GTE, filter.Value);
        break;
      case 'lt':
        this.andWhere(filter.Column, SqlOperator.LT, filter.Value);
        break;
      case 'lte':
        this.andWhere(filter.Column, SqlOperator.LTE, filter.Value);
        break;
      case 'like':
        this.andWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}%`);
        break;
      case 'b-like':
        this.andWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}`);
        break;
      case 'e-like':
        this.andWhere(filter.Column, SqlOperator.LIKE, `${filter.Value}%`);
      case 'in':
        this.whereIn(filter.Column, filter.Value);
        break;
      case 'nin':
        this.whereNotIn(filter.Column, filter.Value);
        break;
      case 'between':
        this.andWhere(filter.Column, SqlOperator.BETWEEN, filter.Value);
        break;
      case 'isnull':
        this.andWhere(filter.Column, SqlOperator.NULL);
        break;
      case 'notnull':
        this.andWhere(filter.Column, SqlOperator.NOT_NULL);
        break;
      case 'notbetween':
        this.andWhere(filter.Column, SqlOperator.NOT_BETWEEN, filter.Value);
        break;
      case "exists":
        this.whereExist(filter.Column);
        break;
      case "n-exists":
        this.whereNotExists(filter.Column);
        break;
    }
  });

  return this;
};
