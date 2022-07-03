/**
 * Default schema for common route parameters taken from url
 */
export const ROUTE_ARG_SCHEMA = {
  Number: {
    anyOf: [
      {
        type: ['number'],
      },
      {
        type: 'string',
        pattern: '^[0-9]+$',
      },
    ],
  },
  String: {
    type: ['string'],
    maxLength: 512,
  },
  Boolean: {
    anyOf: [{ type: 'boolean' }, { type: 'string', pattern: '^true|false|0|1$' }, { type: 'integer', minimum: 0, maximum: 1 }],
  },
};
