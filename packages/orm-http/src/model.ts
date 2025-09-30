import { IModelDescriptor, OrmException, SelectQueryBuilder, createQuery } from '@spinajs/orm';
import './builders.js';
import { IColumnFilter, IFilterRequest, FilterableLogicalOperators } from './interfaces.js';

export const MODEL_STATIC_MIXINS = {
  async filter(filterRequest: IFilterRequest) {
    const { query } = createQuery(this, SelectQueryBuilder);
    return (query as any).filter(filterRequest.filters, filterRequest.op);
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

    return {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [FilterableLogicalOperators.And, FilterableLogicalOperators.Or],
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            anyOf: [...modelDescriptor.FilterableColumns.entries()].map(([key, val]: [string, IColumnFilter<unknown>]) => {
              return {
                type: 'object',
                required: ['Column', 'Operator'],
                properties: {
                  Column: { const: key },
                  Value: { type: ['string', 'integer', 'array', 'boolean'] },
                  Operator: { type: 'string', enum: val.operators },
                },
              };
            }),
          },
        },
      },
    };
  },
};
