declare function registerConfigurationSchema(schema: unknown): void;
declare function ruleOf(kind: string): object;

const FROZEN = Object.freeze(['a', 'b'] as const);
const TYPED: readonly string[] = Object.freeze(['c']);
const PLAIN = ['d'];
// The authn-oidc claim path: `claimPath.anyOf` is a property read, which the compiler cannot evaluate.
const claimPath = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

registerConfigurationSchema({
  $id: 'spinajs/readable.configuration.schema.json',
  $configurationModule: 'readable',
  type: 'object',
  properties: {
    store: { type: 'string', enum: [...FROZEN, ...TYPED, 'e'] },
    list: { type: 'array', default: [...PLAIN] },
    frozen: { enum: FROZEN },
    nothing: { default: null, anyOf: [{ const: null }, { type: 'string' }] },
  },
});

registerConfigurationSchema({
  $id: 'spinajs/unreadable.configuration.schema.json',
  $configurationModule: 'unreadable',
  type: 'object',
  allOf: [ruleOf('a'), ruleOf('b')],
  properties: {
    some: { anyOf: [{ const: null }, ruleOf('c')] },
    none: { type: 'string', enum: [...Object.keys({ a: 1 })] },
    claim: { anyOf: [{ const: null }, ...claimPath.anyOf] },
    kind: { type: 'string', enum: ['a', ...Object.keys({ b: 1 })] },
  },
});
