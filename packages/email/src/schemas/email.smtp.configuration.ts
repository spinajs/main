const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/email.configuration.schema.json',
  $configurationModule: 'email',
  description: 'Email smtp transport configuration option validation',
  type: 'object',
  properties: {
    queue: 'string',
    connections: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          ssl: { type: 'boolean' },
          host: { type: 'string' },
          port: { type: 'number' },
          user: { type: 'string' },
          password: { type: 'string' },
          name: { type: 'string' },
          sender: { type: 'string' },
          options: {
            type: 'object',
          },
          defaults: {
            type: 'object',
            properties: {
              mailFrom: { type: 'string' },
            },
          },
        },
      },
    },
  },
  required: ['name', 'sender'],
};

export default CONFIGURATION_SCHEMA;
