import { IModelDescriptor, OrmException, SelectQueryBuilder, createQuery } from '@spinajs/orm';
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

    return [...modelDescriptor.FilterableColumns.entries()].map(([key, val] : [string, FilterableOperators[]]) => {
      return {
        column: key,
        operators: val,
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
            required: ['Column', 'Value', 'Operator'],
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
