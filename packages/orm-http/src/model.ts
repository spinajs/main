import { IModelDescriptor, OrmException } from '@spinajs/orm';

export const MODEL_STATIC_MIXINS = {
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
      oneOf: modelDescriptor.Columns.filter((c) => c.Filterable !== null && c.Filterable !== undefined && c.Filterable.length > 0).map((c) => {
        return {
          type: 'object',
          required: ['field', 'value', 'operator'],
          properties: {
            field: { const: c.Name },
            value: { type: ['string', 'integer'] },
            operator: c.Filterable,
          },
        };
      }),
    };
  },
};
