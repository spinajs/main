import { IModelDescriptor, OrmException, SelectQueryBuilder, WhereFunction, createQuery } from '@spinajs/orm';
import './builders.js';
import { FilterableOperators, IFilter } from './interfaces.js';

export const MODEL_STATIC_MIXINS = {
  async filter(filters: IFilter[]) {
    const { query } = createQuery(this, SelectQueryBuilder);
    return (query as any).filter(filters);
  },

  filterColumns() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    return [...modelDescriptor.FilterableColumns.entries()].map(([key, val] : [string, FilterableOperators[] | ((operator : FilterableOperators, value: any) => WhereFunction<unknown>)]) => {
      return {
        column: key,
        operators: typeof val === 'function' ? [] : val,
        query: typeof val === 'function' ? val : undefined,
      };
    });
  },

  filterSchema() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    return {
      type: 'array',
      items: {
        type: 'object',
        anyOf: [...modelDescriptor.FilterableColumns.entries()].map(([key, val]: [string, FilterableOperators[]]) => {
          return {
            type: 'object',
            required: ['Column', 'Operator'],
            properties: {
              Column: { const: key },
              Value: { type: ['string', 'integer', 'array'] },
              Operator: { type: 'string', enum: val },
            },
          };
        }),
      },
    };
  },
};
