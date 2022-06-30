/**
 * Default schema for common route parameters taken from url
 */
export const ROUTE_ARG_SCHEMA = {
  Number: {
    type: ['number', 'null'],
  },
  String: {
    type: ['string', 'null'],
    maxLength: 512,
  },
  Boolean: {
    type: ['boolean', 'null'],
  },
};
