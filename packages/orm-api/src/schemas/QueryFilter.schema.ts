const QueryFilterSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      val: { type: 'number' },
      op: { type: 'string', enum: ['=', '!=', 'like', '<', '>', '<=', '>='] },
    },
    required: ['key', 'val'],
  },
};

export default QueryFilterSchema;
