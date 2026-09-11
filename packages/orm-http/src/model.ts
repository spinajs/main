import { IModelDescriptor, OrmException, SelectQueryBuilder, createQuery } from '@spinajs/orm';
import './builders.js';
import { IColumnFilter, IFilterRequest, FilterableLogicalOperators } from './interfaces.js';

export const MODEL_STATIC_MIXINS = {
  async filter(filterRequest?: IFilterRequest) {
    const { query } = createQuery(this, SelectQueryBuilder);
    return (query as any).filter(filterRequest?.filters, filterRequest?.op);
  },

  filterColumns() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    if(modelDescriptor.FilterableColumns === undefined){
      return [];
    }

    return [...modelDescriptor.FilterableColumns.entries()].map(([key, val]: [string, IColumnFilter<unknown>]) => {
      return {
        column: key,
        operators: val.operators,
        query: val.query,
      };
    });
  },

  filterSchema() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    if (modelDescriptor.FilterableColumns === undefined){
      return {};
    }

    const logicalOperator = {
      type: 'string',
      enum: [FilterableLogicalOperators.And, FilterableLogicalOperators.Or],
    };

    /** One condition on one filterable column - `{ Column, Operator, Value }`. */
    const leaf = [...modelDescriptor.FilterableColumns.entries()].map(([key, val]: [string, IColumnFilter<unknown>]) => {
      return {
        type: 'object',
        required: ['Column', 'Operator'],
        properties: {
          Column: { const: key },
          Value: { type: ['string', 'integer', 'array', 'boolean'] },
          Operator: { type: 'string', enum: val.operators },
        },
      };
    });

    /**
     * A nested group - `{ op, filters }` holding leaves of its own.
     *
     * Needed by any search that spans columns: "find this text in the name OR in the id" has to
     * OR those two while the filters around it keep ANDing, and a flat list cannot express that.
     * One level deep is deliberate. It covers the case, and an unbounded schema would let a
     * client nest arbitrarily far - the builder walks whatever arrives, so the depth is a cost
     * someone else pays.
     */
    const group = {
      type: 'object',
      required: ['filters'],
      properties: {
        op: logicalOperator,
        filters: {
          type: 'array',
          items: { type: 'object', anyOf: leaf },
        },
      },
    };

    return {
      type: 'object',
      properties: {
        op: logicalOperator,
        filters: {
          type: 'array',
          items: {
            type: 'object',
            anyOf: [...leaf, group],
          },
        },
      },
    };
  },
};
