import { SqlOperator, WhereBuilder } from "@spinajs/orm";
import { IFilter } from "./interfaces.js";

/**
 * Extend where builder with  flter func old style ( by prototype )
 */
WhereBuilder.prototype.filter = function (this: WhereBuilder<any>, filters: IFilter[]) {
    filters.forEach((filter) => {
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
          this.andWhere(filter.Column, SqlOperator.LIKE, filter.Value);
          break;
        case 'in':
          this.andWhere(filter.Column, SqlOperator.IN, filter.Value);
          break;
        case 'nin':
          this.andWhere(filter.Column, SqlOperator.NOT_IN, filter.Value);
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
      }
    });

    return this;
  }