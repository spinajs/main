
const QueryArgsSchema = {
    type: 'object',
    properties: {
        page: { type: 'number' },
        perPage: { type: 'number' },
        orderDirection: { type: 'string', enum: ['ASC', 'DESC'] },
        order: { type: 'string' },
    },
};

export default QueryArgsSchema;