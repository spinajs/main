/** JSON Schema (draft 2020-12) of `PolicyIR`. Structure only; `validateIR` checks references and types. */
export const POLICY_IR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://spinajs.dev/schemas/authz-ir/policy-ir.json',
  title: 'PolicyIR',
  type: 'object',
  required: ['version', 'types', 'permissions', 'caveats', 'combine', 'principal', 'opaque'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    types: { type: 'object', additionalProperties: { $ref: '#/$defs/typeDef' } },
    permissions: { type: 'object', additionalProperties: { $ref: '#/$defs/permissionBinding' } },
    caveats: { type: 'object', additionalProperties: { $ref: '#/$defs/caveatDef' } },
    combine: {
      type: 'object',
      required: ['default'],
      additionalProperties: false,
      properties: { default: { $ref: '#/$defs/combineEntry' }, types: { type: 'object', additionalProperties: { $ref: '#/$defs/combineEntry' } } },
    },
    principal: {
      type: 'object',
      required: ['ceiling', 'delegation', 'ancestry', 'roles'],
      additionalProperties: false,
      properties: {
        ceiling: { type: 'boolean' },
        delegation: { type: 'boolean' },
        ancestry: { $ref: '#/$defs/name' },
        roles: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', required: ['type', 'relation'], additionalProperties: false, properties: { type: { $ref: '#/$defs/name' }, relation: { $ref: '#/$defs/name' } } } } },
      },
    },
    opaque: { type: 'array', items: { $ref: '#/$defs/opaqueRef' } },
  },
  $defs: {
    name: { type: 'string', minLength: 1 },
    sourceRef: { type: 'object', required: ['origin'], additionalProperties: false, properties: { origin: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 } } },
    typeDef: {
      type: 'object',
      required: ['relations', 'permissions'],
      additionalProperties: false,
      properties: { relations: { type: 'object', additionalProperties: { $ref: '#/$defs/relationDef' } }, permissions: { type: 'object', additionalProperties: { $ref: '#/$defs/rewrite' } } },
    },
    subjectTypeRef: {
      oneOf: [
        { type: 'string', pattern: '^[^#:]+(#[^#:]+|:\\*)?$' },
        { type: 'object', required: ['type', 'caveat'], additionalProperties: false, properties: { type: { type: 'string', pattern: '^[^#:]+(#[^#:]+|:\\*)?$' }, caveat: { $ref: '#/$defs/name' } } },
      ],
    },
    relationDef: {
      type: 'object',
      required: ['allowed', 'source'],
      additionalProperties: false,
      properties: {
        allowed: { type: 'array', items: { $ref: '#/$defs/subjectTypeRef' } },
        source: {
          oneOf: [
            { type: 'object', required: ['kind', 'store'], additionalProperties: false, properties: { kind: { const: 'tuples' }, store: { type: 'string' } } },
            { type: 'object', required: ['kind', 'model', 'column'], additionalProperties: false, properties: { kind: { const: 'column' }, model: { type: 'string' }, column: { type: 'string' }, typeColumn: { type: 'string' } } },
            { type: 'object', required: ['kind', 'via'], additionalProperties: false, properties: { kind: { const: 'ancestor' }, via: { type: 'string' } } },
            { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'self' } } },
          ],
        },
      },
    },
    rewrite: {
      oneOf: [
        { type: 'object', required: ['this'], additionalProperties: false, properties: { this: { const: true } } },
        { type: 'object', required: ['computed'], additionalProperties: false, properties: { computed: { $ref: '#/$defs/name' } } },
        {
          type: 'object',
          required: ['tupleToUserset'],
          additionalProperties: false,
          properties: { tupleToUserset: { type: 'object', required: ['tupleset', 'computed'], additionalProperties: false, properties: { tupleset: { $ref: '#/$defs/name' }, computed: { $ref: '#/$defs/name' } } } },
        },
        { type: 'object', required: ['union'], additionalProperties: false, properties: { union: { type: 'array', minItems: 1, items: { $ref: '#/$defs/rewrite' } } } },
        { type: 'object', required: ['intersection'], additionalProperties: false, properties: { intersection: { type: 'array', items: { $ref: '#/$defs/rewrite' } } } },
        {
          type: 'object',
          required: ['exclusion'],
          additionalProperties: false,
          properties: { exclusion: { type: 'object', required: ['base', 'subtract'], additionalProperties: false, properties: { base: { $ref: '#/$defs/rewrite' }, subtract: { $ref: '#/$defs/rewrite' } } } },
        },
        { type: 'object', required: ['caveat', 'of'], additionalProperties: false, properties: { caveat: { $ref: '#/$defs/name' }, of: { $ref: '#/$defs/rewrite' } } },
        {
          type: 'object',
          required: ['priority'],
          additionalProperties: false,
          properties: { priority: { type: 'array', items: { type: 'object', required: ['when', 'then'], additionalProperties: false, properties: { when: { $ref: '#/$defs/rewrite' }, then: { enum: ['permit', 'deny'] } } } } },
        },
        { type: 'object', required: ['opaque'], additionalProperties: false, properties: { opaque: { type: 'string' } } },
      ],
    },
    caveatDef: {
      type: 'object',
      required: ['params', 'expr'],
      additionalProperties: false,
      properties: {
        params: { type: 'object', additionalProperties: { enum: ['string', 'int', 'double', 'bool', 'timestamp', 'ipaddress', 'list<string>'] } },
        expr: { type: 'object' },
      },
    },
    permissionBinding: {
      type: 'object',
      required: ['type', 'relation', 'list', 'source'],
      additionalProperties: false,
      properties: {
        type: { $ref: '#/$defs/name' },
        relation: { $ref: '#/$defs/name' },
        fields: { type: 'object', additionalProperties: false, properties: { read: { $ref: '#/$defs/strings' }, write: { $ref: '#/$defs/strings' }, hide: { $ref: '#/$defs/strings' } } },
        list: { type: 'boolean' },
        source: { $ref: '#/$defs/sourceRef' },
      },
    },
    strings: { type: 'array', items: { type: 'string' } },
    combineEntry: {
      type: 'object',
      required: ['algorithm'],
      additionalProperties: false,
      properties: {
        algorithm: { oneOf: [{ enum: ['deny-overrides', 'permit-overrides', 'first-applicable'] }, { type: 'object', required: ['opaque'], additionalProperties: false, properties: { opaque: { type: 'string' } } }] },
        models: { $ref: '#/$defs/strings' },
      },
    },
    opaqueRef: {
      type: 'object',
      required: ['kind', 'name'],
      additionalProperties: false,
      properties: { kind: { enum: ['model', 'combinator', 'condition-function', 'native-filter', 'rewrite'] }, name: { type: 'string' }, source: { $ref: '#/$defs/sourceRef' } },
    },
  },
} as const;
