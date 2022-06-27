/**
 * Default schema for common route parameters taken from url
 */
export const ROUTE_ARG_SCHEMA = {
  Number: {
    type: 'number',
  },
  String: {
    type: 'string',
    maxLength: 512,
  },
  Boolean: {
    type: 'boolean',
  },
};
