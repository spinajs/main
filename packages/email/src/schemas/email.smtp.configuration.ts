const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/email.configuration.schema.json',
  $configurationModule: 'email',
  description: 'Email smtp transport configuration option validation',
  type: 'object',
  properties: {
    queue: { type: 'string' },
    templateFs: { type: 'string' },
    retry: {
      type: 'object',
      properties: {
        count: { type: 'number' },
      },
    },
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
          service: { type: 'string' },
          options: {
            type: 'object',
          },
          resilience: {
            type: 'object',
            properties: {
              retries: { type: 'number' },
              delay: { type: 'number' },
              timeout: { type: 'number' },
            },
          },
          defaults: {
            type: 'object',
            properties: {
              mailFrom: { type: 'string' },
            },
          },
        },
        required: ['name', 'service'],
      },
    },
  },
};

export default CONFIGURATION_SCHEMA;
