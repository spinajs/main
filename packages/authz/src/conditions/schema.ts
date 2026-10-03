const ref = {
  type: 'object',
  properties: { ref: { type: 'string', minLength: 1 } },
  required: ['ref'],
  additionalProperties: false,
};

const scalar = { type: ['string', 'number', 'boolean'] };
const literalList = { type: 'array', items: { type: ['string', 'number'] } };

const attrNode = {
  type: 'object',
  properties: {
    attr: { type: 'string', minLength: 1 },
    eq: { anyOf: [scalar, { type: 'null' }, ref] },
    ne: { anyOf: [scalar, { type: 'null' }, ref] },
    in: { anyOf: [literalList, ref] },
    nin: { anyOf: [literalList, ref] },
    lt: { anyOf: [scalar, ref] },
    lte: { anyOf: [scalar, ref] },
    gt: { anyOf: [scalar, ref] },
    gte: { anyOf: [scalar, ref] },
    like: { anyOf: [{ type: 'string' }, ref] },
    glob: { anyOf: [{ type: 'string' }, ref] },
    wildcard: { anyOf: [{ type: 'string' }, ref] },
    null: { type: 'boolean' },
  },
  required: ['attr'],
  additionalProperties: false,
  minProperties: 2,
  maxProperties: 2,
};

/**
 * JSON schema (draft-07, AJV 8) of a `Condition` (design §5.9). It checks shapes only;
 * `parseCondition` adds the ref grammar, the function names and the size caps.
 */
export const CONDITION_SCHEMA = Object.freeze({
  $id: 'https://spinajs.com/schemas/authz/condition.json',
  type: 'object',
  anyOf: [{ required: ['all'] }, { required: ['any'] }, { required: ['not'] }, { required: ['attr'] }, { required: ['fn'] }],
  allOf: [
    { if: { required: ['all'] }, then: { properties: { all: { type: 'array', items: { $ref: '#' } } }, additionalProperties: false } },
    { if: { required: ['any'] }, then: { properties: { any: { type: 'array', items: { $ref: '#' } } }, additionalProperties: false } },
    { if: { required: ['not'] }, then: { properties: { not: { $ref: '#' } }, additionalProperties: false } },
    { if: { required: ['attr'] }, then: attrNode },
    { if: { required: ['fn'] }, then: { properties: { fn: { type: 'string', minLength: 1 }, args: { type: 'object' } }, additionalProperties: false } },
  ],
});
