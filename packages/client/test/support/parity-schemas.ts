// Hand-written schemas aimed at the emitter's riskier rows. Each set is sent as whole bodies by `manifestWith`.
type Schemas = Record<string, unknown>;

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

/** Draft-07 keywords with a body-shaped mapping: arrays, unions, merges, enums, formats, numbers, recursion. */
export function core(): Schemas {
  return {
    Strict: obj({ a: { type: 'string' } }),
    Strict2: obj({ b: { type: 'number' } }, { required: ['b'] }),
    Strict3: obj({ c: { type: 'boolean' } }),
    Bounded: obj({
      a: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
      b: { type: 'array', items: { type: 'number' }, maxItems: 20 },
      c: { type: 'array', items: { type: 'string' }, maxItems: 21 },
      d: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
      e: { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'boolean' }, minItems: 1, maxItems: 3 },
      f: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, uniqueItems: true },
      g: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 25 },
      h: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
      i: { type: 'array', minItems: 1, maxItems: 2 },
      j: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 1, additionalItems: false },
    }),
    MinItems: obj({
      a: { type: 'array', minItems: 2 },
      b: { type: 'array', items: [{ type: 'string' }], minItems: 2 },
      c: { type: 'array', items: {}, minItems: 1, maxItems: 30 },
      d: { type: 'array', items: { type: 'string' }, minItems: 2 },
    }),
    Typeless: obj({
      a: { minLength: 2 },
      b: { minimum: 3 },
      c: { properties: { x: { type: 'string' } }, required: ['x'] },
      d: { items: { type: 'string' } },
      f: { description: 'anything' },
      g: { format: 'email' },
      h: { required: ['k'] },
      i: { maxItems: 2 },
      j: { minimum: 1, maxLength: 3 },
      k: { format: 'int32' },
      l: { $ref: 'test/Strict', minProperties: 0, maxLength: 2 },
      m: { enum: ['a', 'bb', 1], minLength: 2 },
      n: { additionalProperties: false },
      o: { default: 'x', minLength: 2 },
    }),
    OneOf: obj({
      a: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      b: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      c: { oneOf: [{ type: 'object', properties: { x: { type: 'number' } } }, { type: 'object', properties: { y: { type: 'number' } } }] },
      d: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      e: { oneOf: [{ type: 'string', minLength: 2 }, { type: 'string', maxLength: 3 }] },
      f: { oneOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict2' }] },
    }),
    A1: obj({ kind: { const: 'a' }, x: { type: 'string' } }, { required: ['kind'] }),
    A2: { type: 'object', properties: { kind: { enum: ['a', 'b'] } }, required: ['kind'] },
    Disc: { oneOf: [{ $ref: 'test/A1' }, { $ref: 'test/A2' }], 'x-discriminator': { propertyName: 'kind' } },
    Objects: obj({
      strict: obj({ a: { type: 'string' } }),
      loose: { type: 'object', properties: { a: { type: 'string' } } },
      req: { type: 'object', properties: { a: {} }, required: ['a', 'b'] },
      proto: { type: 'object', properties: { constructor: { type: 'string' }, toString: { type: 'number' } } },
      protoreq: { type: 'object', required: ['toString', 'valueOf'] },
      empty: obj({}),
    }),
    Dunder: obj({ d: JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}') as unknown }),
    Nullables: obj({
      a: { type: 'string', nullable: true },
      b: { type: ['number', 'null'], minimum: 2 },
      c: { anyOf: [{ $ref: 'test/Strict' }, { type: 'null' }] },
      d: { type: 'object', nullable: true, properties: { x: { type: 'number' } }, additionalProperties: false },
      e: { type: 'string', enum: ['a', 'b', null], nullable: true },
      f: { type: ['string', 'null'], enum: ['a', null] },
    }),
    Enums: obj({
      a: { enum: [1, '1', null, true] },
      b: { enum: [{ a: 1 }, [1, 2], 'x'] },
      c: { const: { a: [1, { b: 2 }] } },
      d: { const: 0 },
      e: { enum: ['a', 'b'] },
      f: { const: 'a', minLength: 5 },
      g: { enum: ['__proto__', 'constructor', 'toString'] },
      h: { const: null },
      i: { type: 'integer', enum: [1, 2.5] },
      j: { const: [1] },
      k: { enum: ['a'], type: 'string', minLength: 3 },
    }),
    Formats: obj({
      dt: { type: 'string', format: 'date-time' },
      d: { type: 'string', format: 'date' },
      t: { type: 'string', format: 'time' },
      e: { type: 'string', format: 'email' },
      u: { type: 'string', format: 'uri' },
      uuid: { type: 'string', format: 'uuid' },
      i32: { type: 'integer', format: 'int32' },
      sn: { type: ['string', 'number'], format: 'email' },
      unk: { type: 'string', format: 'zip' },
      re: { type: 'string', format: 'regex' },
      ipv4: { type: 'string', format: 'ipv4' },
      h: { type: 'string', format: 'hostname' },
      fmin: { type: 'string', format: 'date', formatMinimum: '2020-01-01' },
    }),
    Lengths: obj({
      a: { type: 'string', minLength: 2, maxLength: 3 },
      p: { type: 'string', pattern: '^\\p{L}+$' },
      q: { type: 'string', pattern: 'a' },
    }),
    Numbers: obj({
      i: { type: 'integer', minimum: 0 },
      m: { type: 'number', multipleOf: 0.1 },
      x: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      ui: { type: ['integer', 'string'] },
      ni: { type: ['number', 'integer'], maximum: 2 },
    }),
    Merge: { allOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict2' }] },
    MergeAnyOf: { allOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict2' }], anyOf: [{ required: ['a'] }, { required: ['c'] }] },
    MergeOpen: { allOf: [{ $ref: 'test/Strict' }, { type: 'object', properties: { b: { type: 'number' } } }] },
    MergeOwnProps: { allOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict2' }], properties: { a: { type: 'number' }, c: { type: 'boolean' } }, required: ['c'] },
    MergeNested: { allOf: [{ $ref: 'test/Merge' }, { $ref: 'test/Strict3' }] },
    MergeInline: { allOf: [obj({ a: { type: 'string' } }), obj({ a: { type: 'string', minLength: 2 }, b: { type: 'number' } })] },
    MergeTyped: { type: 'object', allOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict3' }], minProperties: 1 },
    RefSiblings: { $ref: 'test/Strict', description: 'x', required: ['a'] },
    RootNullable: { type: ['object', 'null'], properties: { a: { type: 'string' } }, additionalProperties: false },
    RootAnyOf: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, anyOf: [{ required: ['a'] }, { required: ['b'] }] },
    RootPattern: { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'number' } }, additionalProperties: false },
    RootReq: { type: 'object', properties: { a: {} }, required: ['a'], additionalProperties: false },
    Recursive: obj({ v: { type: 'number' }, next: { anyOf: [{ $ref: 'test/Recursive' }, { type: 'null' }] }, kids: { type: 'array', items: { $ref: 'test/Recursive' }, maxItems: 2 } }, { required: ['v'] }),
    RecArray: { type: 'array', items: { $ref: 'test/RecArray' } },
    RootArray: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    RootString: { type: 'string', minLength: 1 },
    Unique: obj({
      a: { type: 'array', uniqueItems: true },
      b: { type: 'array', items: { type: 'object' }, uniqueItems: true },
      c: { type: 'array', items: { type: ['string', 'null'] }, uniqueItems: true },
      d: { type: 'array', items: { type: 'number' }, uniqueItems: true, maxItems: 3 },
    }),
  };
}

/** The refine-based keywords of the draft-07 subset: not, if/then/else, contains, object keywords. */
export function keywords(): Schemas {
  return {
    S5Base: obj({ a: { type: 'string' } }, { required: ['a'] }),
    S5Bounded: obj({ a: { type: 'string' }, b: { type: 'number' } }, { minProperties: 1 }),
    Not: obj({
      a: { type: 'string', not: { const: 'x' } },
      b: { type: ['string', 'null'], not: { type: 'null' } },
      c: { not: { type: 'object' } },
      d: { type: 'number', not: { minimum: 5 } },
      e: { not: { required: ['k'] } },
      f: { not: true },
      g: { not: { $ref: 'test/S5Base' } },
    }),
    Cond: obj(
      { kind: { type: 'string' }, n: { type: 'number' }, s: { type: 'string' } },
      { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['n'] }, else: { not: { required: ['n'] } } },
    ),
    CondParts: obj({
      a: { type: 'number', if: { minimum: 5 }, then: { multipleOf: 2 } },
      b: { type: 'string', if: { minLength: 3 }, else: { pattern: '^x' } },
      d: { type: 'number', if: { minimum: 0 } },
    }),
    Contains: obj({
      a: { type: 'array', items: { type: 'number' }, contains: { minimum: 5 } },
      b: { type: 'array', contains: { type: 'string' }, maxItems: 3 },
      c: { contains: { const: 1 } },
      d: { type: 'array', contains: { $ref: 'test/S5Base' } },
    }),
    Patterns: obj({
      a: { ...obj({ x: { type: 'string' } }), patternProperties: { '^x': { type: 'string', minLength: 2 }, '1$': { type: 'number' } } },
      b: { type: 'object', patternProperties: { '^n': { type: 'number' } }, additionalProperties: { type: 'string' } },
      c: { type: 'object', patternProperties: { '^\\p{L}+$': { type: 'boolean' } } },
      d: { patternProperties: { '^a': { const: 1 } } },
    }),
    Names: obj({
      a: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
      b: { type: 'object', propertyNames: { maxLength: 1 } },
      c: { propertyNames: { enum: ['a', 'b'] } },
      d: { type: 'object', propertyNames: false },
    }),
    Deps: obj({
      a: { type: 'object', properties: { a: {}, b: {}, c: { type: 'number' } }, dependencies: { a: ['b'], c: { required: ['a'] } } },
      b: { type: 'object', dependencies: { toString: ['x'], valueOf: { required: ['y'] } } },
      c: { dependencies: { a: [] } },
    }),
    Counts: obj({
      a: { type: 'object', minProperties: 1, maxProperties: 2 },
      b: { minProperties: 2 },
      c: { type: 'object', maxProperties: 0 },
    }),
    MergedKw: { allOf: [{ $ref: 'test/S5Bounded' }, obj({ c: { type: 'boolean' } }, { not: { required: ['c', 'b'] } })] },
    RootCond: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, if: { required: ['a'] }, then: { minProperties: 1 } },
    RootPattern5: { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'number' } }, additionalProperties: false, propertyNames: { maxLength: 3 } },
    RecNot: obj({ v: { type: 'number' }, next: { not: { $ref: 'test/RecNot' } }, kids: { type: 'array', items: { $ref: 'test/RecNot' }, contains: { required: ['v'] } } }),
    RPatMix: obj({ x1: { type: 'string' } }, { patternProperties: { '^x': { type: 'string', minLength: 2 } } }),
    RDeps: obj({ a: { type: 'string' }, b: { type: 'string' } }, { dependencies: { a: { properties: { b: { const: 'x' } } }, constructor: ['b'] } }),
    RDepsOpen: { type: 'object', properties: { a: { type: 'string' } }, dependencies: { constructor: ['zz'], toString: ['yy'] } },
    RNames: { type: 'object', propertyNames: { minLength: 2, not: { const: '__proto__' } } },
    RMinProps: { type: 'object', minProperties: 1, maxProperties: 1 },
    RIfOnly: obj({ a: { type: 'number', if: { minimum: 1 } } }),
    RThenOnly: obj({ a: { type: 'number', then: { minimum: 100 } } }),
    RNotRef: obj({ a: { not: { $ref: 'test/RClosed' } } }),
    RClosed: obj({ k: { type: 'string' } }, { required: ['k'] }),
    RMergedIf: { allOf: [{ $ref: 'test/RClosed' }, obj({ n: { type: 'number' } }, { if: { required: ['n'] }, then: { properties: { n: { minimum: 0 } } } })] },
    RContainsObj: obj({ list: { type: 'array', items: { $ref: 'test/RClosed' }, contains: { properties: { k: { const: 'yes' } } } } }),
    RMinItemsContains: obj({ list: { type: 'array', contains: { type: 'null' }, minItems: 2 } }),
    RDefaults: obj({ a: { type: 'string', default: 'x' }, b: { type: 'number', default: 1 }, c: { type: 'array', default: [] } }),
  };
}

/** `$data`, ajv-keywords and merge patches: the keywords only an explicit `@Schema` class carries. */
export function explicit(): Schemas {
  return {
    Data: obj({
      password: { type: 'string' },
      confirm: { type: 'string', const: { $data: '1/password' } },
      min: { type: 'number' },
      max: { type: 'number', minimum: { $data: '1/min' } },
      tags: { type: 'array', maxItems: { $data: '1/max' } },
      far: { type: 'number', maximum: { $data: '/max' } },
    }),
    Merge5: { $merge: { source: { $ref: 'test/S5Base' }, with: { properties: { b: { type: 'number' } }, required: ['b'] } } },
    MergeInline5: { $merge: { source: obj({ a: { type: 'string' }, b: { type: 'number' } }), with: { properties: { b: null, c: { type: 'boolean' } } } } },
    Patch5: { $patch: { source: { $ref: 'test/S5Base' }, with: [{ op: 'add', path: '/properties/b', value: { type: 'number' } }, { op: 'add', path: '/required/-', value: 'b' }] } },
    PatchBad: { $patch: { source: { $ref: 'test/S5Base' }, with: [{ op: 'remove', path: '/nowhere' }] } },
    Kw: obj({
      r: { type: 'number', range: [1, 3] },
      x: { type: 'number', exclusiveRange: [0, 3] },
      t: { type: 'string', transform: ['trim', 'toLowerCase'], enum: ['ab', 'cd'] },
      l: { type: 'string', transform: ['trim'], minLength: 2, maxLength: 3 },
      e: { type: 'string', transform: ['toEnumCase'], enum: ['ABC', 'Def'] },
      u: { type: 'string', transform: ['toUpperCase'], pattern: '^[A-Z]+$' },
      re: { type: 'string', regexp: '/^a+$/' },
      rf: { type: 'string', regexp: { pattern: '^a$', flags: 'i' } },
      up: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, tag: { type: 'object' } } }, uniqueItemProperties: ['id', 'tag'] },
      dropped: { type: 'object', anyRequired: ['a', 'b'], prohibited: ['c'] },
    }),
  };
}

/** Roots sent as a query, path, header or cookie value; fields whose coercion order matters. */
export function coercion(): Schemas {
  const fields: Record<string, unknown> = {
    page: { type: 'integer', minimum: 1 },
    size: { type: 'number', maximum: 100 },
    flag: { type: 'boolean' },
    ids: { type: 'array', items: { type: 'number' } },
    names: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    q: { type: ['string', 'null'] },
    n: { type: 'null' },
    s: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['a', 'b'] },
    either: { anyOf: [{ type: 'number' }, { type: 'boolean' }] },
    inner: { $ref: 'test/CInner' },
    nullableNum: { type: 'number', nullable: true },
    c: { type: 'number', const: 5 },
    notTwo: { type: 'number', not: { const: 2 } },
    branchMutates: { anyOf: [{ type: 'number', minimum: 10 }, { type: 'boolean' }] },
    oneOfCoerced: { oneOf: [{ type: 'integer' }, { type: 'string', minLength: 3 }] },
    multi: { type: ['integer', 'string', 'null'] },
    allOfTypes: { allOf: [{ type: 'number' }, { minimum: 1 }] },
    arr2: { type: 'array', items: [{ type: 'integer' }, { type: 'boolean' }], minItems: 1 },
    multi1: { type: ['string', 'integer'] },
    multi2: { type: ['integer', 'boolean', 'null'] },
    multi3: { type: ['boolean', 'number'], minimum: 1 },
    multi4: { type: ['array', 'number'], items: { type: 'integer' } },
    multi5: { type: ['null', 'string'], minLength: 1 },
    allA: { allOf: [{ type: 'integer' }, { type: 'number', minimum: 2 }] },
    allB: { allOf: [{ type: 'string' }, { type: 'number' }] },
    allC: { allOf: [{ minimum: 3 }, { type: 'integer' }] },
    allD: { allOf: [{ type: 'boolean' }, { enum: [true] }] },
    allE: { type: 'number', allOf: [{ maximum: 9 }] },
    nullRef: { anyOf: [{ $ref: 'test/CPage' }, { type: 'null' }] },
    nullInline: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    nullEnum: { anyOf: [{ $ref: 'test/CStatus' }, { type: 'null' }] },
    mutateRef: { oneOf: [{ $ref: 'test/CPage' }, { type: 'string', maxLength: 0 }] },
    arrU: { type: 'array', items: { type: 'number' }, uniqueItems: true, contains: { minimum: 5 } },
    arrOne: { type: 'array', items: { type: 'boolean' }, maxItems: 1 },
    constNum: { type: 'number', const: 0 },
    enumNum: { type: 'integer', enum: [1, 2] },
  };
  const out: Schemas = {
    CQuery: obj(fields),
    CInner: obj({ n: { type: 'number' }, t: { type: ['number', 'string'] } }),
    CPage: { type: 'integer', minimum: 1 },
    CStatus: { type: 'string', enum: ['a', 'b'] },
    CRootMulti: { type: ['integer', 'boolean'] },
  };
  for (const [name, schema] of Object.entries(fields)) out[`CF_${name}`] = obj({ v: schema }, { required: ['v'] });
  return out;
}

/**
 * One schema per looser verdict the emitter cannot name with a diagnostic, or names with `ZOD004`, so that a pin in the
 * suite excuses that gap alone. The pins are in `zod-parity.test.ts`.
 */
export function gaps(): Schemas {
  return {
    IfCoerces: obj({ v: { if: { type: 'number' }, then: { minimum: 3 } } }, { required: ['v'] }),
    GapPatternCoerced: { type: 'object', properties: { a: { type: 'number' } }, patternProperties: { '^a$': { minimum: 3 } } },
    GapAnyOfCoerces: obj({ v: { minLength: 2, anyOf: [{ type: 'string' }, { type: 'number' }] } }, { required: ['v'] }),
    GapDataOrder: obj({
      max: { type: 'number', multipleOf: { $data: '1/step' } },
      step: { type: 'number' },
      name: { type: 'string', maxLength: { $data: '1/limits/name' } },
      limits: { type: 'object', properties: { name: { type: 'integer' } } },
    }),
    GapNotInfinity: obj({ v: { type: 'string', not: { type: 'number' } } }, { required: ['v'] }),
    GapOneOfInfinity: obj({ v: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, { required: ['v'] }),
    GapProtoCatchall: obj({ v: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } } }, { required: ['v'] }),
  };
}
