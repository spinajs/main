import { IModelDescriptor, OrmException, SelectQueryBuilder, createQuery } from '@spinajs/orm';
import './builders.js';
import { IFilter } from './interfaces.js';

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

    return modelDescriptor.Columns.filter((c) => c.Filterable !== null && c.Filterable !== undefined && c.Filterable.length > 0).map((c) => {
      return {
        column: c.Name,
        operators: c.Filterable,
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
        anyOf: modelDescriptor.Columns.filter((c) => c.Filterable !== null && c.Filterable !== undefined && c.Filterable.length > 0).map((c) => {
          return {
            type: 'object',
            required: ['Field', 'Value', 'Operator'],
            properties: {
              Field: { const: c.Name },
              Value: { type: ['string', 'integer'] },
              Operator: { type: 'string', enum: c.Filterable },
            },
          };
        }),
      },
    };
  },
};
