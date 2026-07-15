export default {
  $id: 'http://spinajs/example_mjs.schema.mjs',
  title: 'Order',
  description: 'An order from Acme catalog',
  type: 'object',
  properties: {
    orderId: {
      description: 'The unique identifier for an order',
      type: 'integer',
    },
  },
  required: ['orderId'],
};
