const CONFIGURATION_SCHEMA = {
  $id: 'spinajs/email.configuration.schema.json',
  $configurationModule: 'email.smtp',
  description: 'Email smtp transport configuration option validation',
  type: 'object',
  properties: {
    rules: {
      description: 'Log rules, what log should be write where',
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
          },
          level: {
            type: 'string',
            enum: ['trace', 'debug', 'warn', 'info', 'error', 'fatal', 'security', 'success'],
          },
          target: {
            oneOf: [
              {
                type: 'string',
              },
              {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            ],
          },
        },
        required: ['name', 'level', 'target'],
      },
    },
  },
};

export default CONFIGURATION_SCHEMA;
