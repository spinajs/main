import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import Ajv from 'ajv';
import ajvMergePatch from 'ajv-merge-patch';
import ajvFormats from 'ajv-formats';
import ajvKeywords from 'ajv-keywords';
import ajvEqual from 'ajv/dist/runtime/equal.js';

import { DataValidator } from '../src/validator.js';
import { IValidationError, ValidationFailed, sanitizeError } from '../src/exceptions/index.js';
import { addSafeKeywords, jsonEqual } from '../src/keywords.js';


interface TestAjv {
  validate(schema: object, data: unknown): boolean;
  errors?: IValidationError[] | null;
  RULES: { rules: { type?: string; rules: { keyword: string }[] }[] };
  removeKeyword(keyword: string): unknown;
  addKeyword(definition: object): unknown;
}

const resolveDefault = <T>(mod: unknown): T => ((mod as { default?: T }).default ?? mod) as T;
const silent = { log() {}, warn() {}, error() {} };
const stockEqual = resolveDefault<(a: unknown, b: unknown) => boolean>(ajvEqual);

const SHIPPED = { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false };

// The Ajv DataValidator.createAjv() builds, without addSafeKeywords.
function stockAjv(options: object): TestAjv {
  const AjvCtor = resolveDefault<new (options: object) => TestAjv>(Ajv);
  const ajv = new AjvCtor({ ...SHIPPED, logger: silent, ...options, $data: true, verbose: true });
  for (const plugin of [ajvMergePatch, ajvFormats, ajvKeywords] as unknown[]) {
    resolveDefault<(ajv: TestAjv) => unknown>(plugin)(ajv);
  }
  return ajv;
}

const safen = (ajv: TestAjv) => addSafeKeywords(ajv as unknown as Parameters<typeof addSafeKeywords>[0]);

function safeAjv(options: object): TestAjv {
  const ajv = stockAjv(options);
  safen(ajv);
  return ajv;
}

function validationConfig(validation: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        validation,
      };
    }
  };
}

async function boot(validation: Record<string, unknown>) {
  const config = validationConfig(validation);
  DI.register(config).as(Configuration);
  DI.uncache(Configuration);
  DI.uncache(DataValidator);
  await DI.resolve(Configuration);
  const validator = await DI.resolve(DataValidator);
  return {
    validator,
    release: () => {
      DI.uncache(DataValidator);
      DI.uncache(Configuration);
      DI.unregister(config);
    },
  };
}

const ser = (v: unknown) => JSON.stringify(v, (_k, x: unknown): unknown => (typeof x === 'number' && !Number.isFinite(x) ? `#num:${x}` : Object.is(x, -0) ? '#num:-0' : x));
const P = (v: object) => ({ type: 'object', properties: { v } });

const OPTION_SETS = [
  { coerceTypes: true, allErrors: true },
  { coerceTypes: true, allErrors: false },
  { coerceTypes: 'array', allErrors: true },
  { coerceTypes: 'array', allErrors: false },
  { coerceTypes: false, allErrors: true },
  { coerceTypes: false, allErrors: false },
];

const SCHEMAS: Record<string, object> = {
  num: { type: 'number' },
  int: { type: 'integer' },
  intBounded: { type: 'integer', minimum: 0, maximum: 100 },
  numMul: { type: 'number', multipleOf: 0.5 },
  numBoundsEnum: { type: 'number', minimum: 0, enum: [1, 2] },
  str: { type: 'string' },
  bool: { type: 'boolean' },
  nul: { type: 'null' },
  obj: { type: 'object' },
  arr: { type: 'array' },
  numNull: { type: ['number', 'null'] },
  intStr: { type: ['integer', 'string'] },
  numBool: { type: ['number', 'boolean'] },
  intNum: { type: ['integer', 'number'] },
  strNum: { type: ['string', 'number'] },
  nullable: { type: 'number', nullable: true },
  nullableInt: { type: 'integer', nullable: true, minimum: 1 },
  noType: { minimum: 0, maximum: 10 },
  noTypeMul: { multipleOf: 2, exclusiveMaximum: 10 },
  strBound: { type: 'string', minimum: 3 },
  anyOfIntStr: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
  anyOfStrInt: { anyOf: [{ type: 'string', maxLength: 3 }, { type: 'integer', minimum: 0 }] },
  oneOfIntNull: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  oneOfIntBool: { oneOf: [{ type: 'integer' }, { type: 'boolean' }] },
  ifThen: { if: { type: 'integer' }, then: { minimum: 5 }, else: { type: 'string' } },
  ifThenNoElse: { type: ['integer', 'string'], if: { type: 'integer' }, then: { minimum: 5 } },
  allOf: { allOf: [{ type: 'number' }, { maximum: 3 }] },
  not: { not: { type: 'string' } },
  enumNum: { type: 'integer', enum: [1, 2, 3] },
  enumMixed: { enum: [1, '1', null, { a: 1 }, [1]] },
  enumAnyOf: { enum: [1, 2], anyOf: [{ type: 'integer' }] },
  enumIf: { enum: ['5'], if: { type: 'integer' }, then: {} },
  constNum: { type: 'number', const: 1 },
  constObj: { const: { a: 1 } },
  constAnyOf: { const: 1, anyOf: [{ type: 'integer' }] },
  constOneOf: { const: true, oneOf: [{ type: 'boolean' }] },
  constAllOf: { const: 0, allOf: [{ type: 'number' }] },
  trimConst: { type: 'string', transform: ['trim'], const: 'a' },
  lowerConst: { type: 'string', transform: ['toLowerCase'], const: 'abc' },
  trimEnum: { type: 'string', transform: ['trim'], enum: ['a'] },
  uniqInt: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
  uniqIntStr: { type: 'array', items: { type: ['integer', 'string'] }, uniqueItems: true },
  uniqNullable: { type: 'array', items: { type: 'integer', nullable: true }, uniqueItems: true },
  uniqAny: { type: 'array', uniqueItems: true },
  uniqStr: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  uniqObj: { type: 'array', items: { type: 'object' }, uniqueItems: true },
  uniqMinItems: { type: 'array', minItems: 3, uniqueItems: true, items: { type: 'number' } },
  tuple: { type: 'array', items: [{ type: 'integer', maximum: 5 }, { type: 'string' }], additionalItems: { type: 'number' } },
  arrInt: { type: 'array', items: { type: 'integer', maximum: 5 } },
  record: { type: 'object', additionalProperties: { type: 'number', maximum: 5 } },
  pattern: { type: 'object', patternProperties: { '^x': { type: 'integer', minimum: 0 } } },
  required: { type: 'object', required: ['a', 'b', 'c'], properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } },
  addlFalse: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
  depReq: { type: 'object', dependencies: { a: ['b', 'c'] } },
  propNames: { type: 'object', propertyNames: { maxLength: 1 } },
  uniqProps: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } }, uniqueItemProperties: ['id'] },
  uniqPropsObj: { type: 'array', uniqueItemProperties: ['m'] },
  range: { type: 'number', range: [0, 5] },
  formatInt32: { type: 'number', format: 'int32' },
  formatInt32Bound: { type: 'number', format: 'int32', maximum: 5, const: 1 },
  strMin: { type: 'string', minLength: 2, pattern: '^a' },
  dataConst: { type: 'object', properties: { a: {}, b: { const: { $data: '1/a' } } } },
  dataEnum: { type: 'object', properties: { a: {}, b: { enum: { $data: '1/a' } } } },
  dataUniq: { type: 'object', properties: { a: {}, b: { type: 'array', uniqueItems: { $data: '1/a' } } } },
  dataMax: { type: 'object', properties: { a: {}, b: { maximum: { $data: '1/a' } } } },
  merge: { $merge: { source: { type: 'object', properties: { v: { type: 'integer', maximum: 5 } } }, with: { required: ['v'] } } },
  mergeConst: { $merge: { source: { type: 'object', properties: { v: { const: 1, allOf: [{ type: 'integer' }] } } }, with: { required: ['v'] } } },
  patch: { $patch: { source: { type: 'object', properties: { v: { type: 'number' } } }, with: [{ op: 'add', path: '/properties/v/minimum', value: 0 }] } },
  refDef: { definitions: { n: { type: 'integer', maximum: 3 } }, type: 'object', properties: { v: { $ref: '#/definitions/n' } } },
};
// whole-data schemas, never wrapped in a property
const UNWRAPPED = new Set(['dataConst', 'dataEnum', 'dataUniq', 'dataMax', 'merge', 'mergeConst', 'patch', 'refDef']);

const VALUES: unknown[] = [
  '1', '1.5', 'abc', '', 'true', 'false', 'null', null, true, false, 0, 1, 1.5, -0, '-0', '0x10', ' 7 ', '1e3', '1e300', ' a ', 'ABC', 'a', '5', '0',
  'Infinity', '-Infinity', '1e400', '-1e400', ' Infinity', 'NaN', Infinity, -Infinity, NaN,
  [], [1], ['1'], [1, '1'], ['1', 1], [1, 1], ['a', 'a'], ['__proto__', '__proto__'], ['toString', 'toString'], [1, 'x'], [5, 'a', 3], [6, 'a', '2'],
  ['-Infinity'], ['Infinity', 'b'], [null, null], [null, 1, null], [{}, {}], [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }], [{ b: 1, a: 2 }, { a: 2, b: 1 }],
  [{ id: 1 }, { id: '1' }], [{ id: 1 }, { id: 1 }], [{ m: { x: 1 } }, { m: { x: 1 } }], [[1], [1]], [[1], { 0: 1 }], [true, 'true'], [0, false], [null, 'null'],
  [{ constructor: {} }, { constructor: {} }],
  {}, { a: 1 }, { a: [1] }, { a: 1, b: 2 }, { b: 2, a: 1 }, { constructor: {} }, { x1: '3', x2: '-Infinity', y: 'Infinity' }, { a: 'x' }, { a: 'x', z: 1, q: 2 },
  { a: 1, b: 1, c: 1 }, { a: 1, b: 1 }, { a: { x: 1 }, b: { x: 1 } }, { a: [1, 2], b: 2 }, { a: [1, 2], b: '2' }, { a: true, b: [1, 1] }, { a: false, b: [1, 1] },
  { a: 3, b: 5 }, { a: 'x', b: 'Infinity' }, { ab: 1, cd: 2 }, { v: '7' }, { v: '-Infinity' }, { v: 'x' },
];

const NONFINITE = /^\s*[-+]?(Infinity|\d*\.?\d+e\d{3,})\s*$/i;
const hasNonFinite = (x: unknown): boolean =>
  (typeof x === 'number' && !Number.isFinite(x)) || (typeof x === 'string' && NONFINITE.test(x) && !Number.isFinite(+x)) || (!!x && typeof x === 'object' && Object.values(x).some(hasNonFinite));

/**
 * The intended differences from stock Ajv, other than non-finite input. Anything else the differential finds fails.
 */
const ALLOWED: [string, (schema: string, value: unknown) => boolean][] = [
  // Ajv indexes strings on `{}`, where a "__proto__" item reads Object.prototype and never counts as a duplicate.
  ['__proto__ duplicate', (schema, value) => schema.startsWith('uniq') && ser(value).includes('["__proto__","__proto__"]')],
  // fast-deep-equal compares `a.constructor` by identity, so two `{ constructor: {} }` values were different.
  ['constructor key equality', (schema, value) => ['uniqAny', 'uniqObj'].includes(schema) && ser(value).includes('{"constructor":{}}')],
];

type Outcome = { threw: string } | { valid: boolean; data: string; errors: string[] };

const listsNumber = (schema: object | undefined) => {
  const type = (schema as { type?: unknown } | undefined)?.type;
  const types: unknown[] = Array.isArray(type) ? type : [type];
  return (types.includes('number') || types.includes('integer')) && !types.includes('string');
};

/**
 * What the fix promises on any input: it never accepts what stock refused on non-finite input, it never accepts data
 * that holds a non-finite number, and a non-finite value under a property whose own `type` lists a number fails that
 * `type` rule ( with allErrors; otherwise an earlier rule may report first ), not only the success-path walk.
 */
function fixHolds(name: string, property: object | undefined, raw: unknown, stock: Outcome, safe: Outcome, allErrors: boolean): string[] {
  if ('threw' in safe || 'threw' in stock) return [];
  const problems: string[] = [];
  const tag = `${name} ${ser(raw)}`;
  if (hasNonFinite(raw) && safe.valid && !stock.valid) problems.push(`accepts what stock refused: ${tag}`);
  if (safe.valid && /#num:(-?Infinity|NaN)/.test(safe.data)) problems.push(`accepts a non-finite number: ${tag} -> ${safe.data}`);
  if (hasNonFinite(raw) && listsNumber(property) && (safe.valid || (allErrors && !safe.errors.some((e) => e.startsWith('["type","/v","#/properties/v/type"'))))) {
    problems.push(`no type error at the property: ${tag} -> ${ser(safe)}`);
  }
  return problems;
}

const errorKey = (e: IValidationError) => ser([e.keyword, e.instancePath, e.schemaPath, e.params]);

function stockOutcome(ajv: TestAjv, schema: object, value: unknown): Outcome {
  const data = structuredClone(value);
  try {
    const valid = ajv.validate(schema, data);
    return { valid, data: ser(data), errors: (ajv.errors ?? []).map((e) => errorKey(sanitizeError(e, schema))) };
  } catch (err) {
    return { threw: (err as Error).message };
  }
}

function safeOutcome(validator: DataValidator, schema: object, value: unknown): Outcome {
  const data = structuredClone(value);
  try {
    const [valid, errors] = validator.tryValidate(schema, data as object);
    return { valid, data: ser(data), errors: (errors ?? []).map(errorKey) };
  } catch (err) {
    return { threw: (err as Error).message };
  }
}

describe('addSafeKeywords against stock Ajv', function () {
  this.timeout(120000);

  describe('differential over the option sets', () => {
    for (const options of OPTION_SETS) {
      it(`${JSON.stringify(options)}: differs only on non-finite input and the allowlist`, async () => {
        const { validator, release } = await boot({ ...SHIPPED, ...options });
        const stock = stockAjv(options);
        const unexpected: string[] = [];
        const problems: string[] = [];
        try {
          for (const [name, inner] of Object.entries(SCHEMAS)) {
            for (const wrapped of UNWRAPPED.has(name) ? [false] : [true, false]) {
              const schema = wrapped ? P(inner) : inner;
              for (const raw of VALUES) {
                // DataValidator answers null / undefined data with its own invalid_argument error.
                if (!wrapped && raw === null) continue;
                const value = wrapped ? { v: raw } : raw;
                const a = stockOutcome(stock, schema, value);
                const b = safeOutcome(validator, schema, value);
                problems.push(...fixHolds(name, wrapped ? inner : undefined, raw, a, b, options.allErrors));
                if (ser(a) === ser(b) || hasNonFinite(raw) || ALLOWED.some(([, allowed]) => allowed(name, raw))) continue;
                unexpected.push(`${name}${wrapped ? '/prop' : ''} ${ser(value)}\n  stock ${ser(a)}\n  safe  ${ser(b)}`);
              }
            }
          }
        } finally {
          release();
        }
        expect(unexpected, unexpected.slice(0, 10).join('\n')).to.deep.eq([]);
        expect(problems, problems.slice(0, 10).join('\n')).to.deep.eq([]);
      });
    }

    it('the allowlisted differences are real', () => {
      const stock = stockAjv({});
      const safe = safeAjv({});
      for (const [schema, value] of [
        [SCHEMAS.uniqStr, ['__proto__', '__proto__']],
        [SCHEMAS.uniqAny, [{ constructor: {} }, { constructor: {} }]],
      ] as const) {
        expect(stock.validate(schema, structuredClone(value)), ser(value)).to.eq(true);
        expect(safe.validate(schema, structuredClone(value)), ser(value)).to.eq(false);
      }
    });
  });

  describe('rule order', () => {
    const order = (ajv: TestAjv) => ajv.RULES.rules.map((g): [string, string[]] => [g.type ?? '-', g.rules.map((r) => r.keyword)]);

    it('keeps every replaced keyword at its stock position', () => {
      expect(order(safeAjv({}))).to.deep.eq(order(stockAjv({})));
    });

    it('const and enum still see the value before transform and the applicators coerce it', () => {
      const stock = stockAjv({});
      const safe = safeAjv({});
      for (const [schema, data] of [
        [P(SCHEMAS.trimConst), { v: ' a ' }],
        [P(SCHEMAS.lowerConst), { v: 'ABC' }],
        [P(SCHEMAS.enumAnyOf), { v: '1' }],
        [P(SCHEMAS.constOneOf), { v: 'true' }],
        [P(SCHEMAS.constAllOf), { v: '0' }],
        [SCHEMAS.mergeConst, { v: '1' }],
      ] as const) {
        expect(stock.validate(schema, structuredClone(data)), `stock ${ser(data)}`).to.eq(false);
        expect(safe.validate(schema, structuredClone(data)), ser(data)).to.eq(false);
      }
    });
  });

  describe('boot guard', () => {
    it('refuses an Ajv whose "type" rule has an implementation', () => {
      const ajv = stockAjv({});
      ajv.removeKeyword('type');
      ajv.addKeyword({ keyword: 'type', schemaType: ['string', 'array'], code() {} });
      expect(() => safen(ajv)).to.throw(Error, /"type" rule is no longer code-less/);
    });

    it('refuses an Ajv without one of the keywords it replaces', () => {
      const ajv = stockAjv({});
      ajv.removeKeyword('const');
      expect(() => safen(ajv)).to.throw(Error, /no "const" keyword/);
    });
  });

  describe('jsonEqual', () => {
    class Point {
      constructor(public x: number) {}
    }
    const same: [string, unknown, unknown][] = [
      ['equal Dates', new Date(5), new Date(5)],
      ['different Dates', new Date(5), new Date(6)],
      ['equal RegExps', /a/gi, /a/gi],
      ['RegExps with other flags', /a/g, /a/i],
      ['equal typed arrays', new Uint8Array([1, 2]), new Uint8Array([1, 2])],
      ['different typed arrays', new Uint8Array([1, 2]), new Uint8Array([1, 3])],
      ['array and object', [1], { 0: 1 }],
      ['key order', { a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }],
      ['missing key', { a: 1, b: undefined }, { a: 1, c: undefined }],
      ['nested difference', { a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }],
      ['NaN', NaN, NaN],
      ['-0 and 0', -0, 0],
      ['class instances', new Point(1), new Point(1)],
      ['class instance and object', new Point(1), { x: 1 }],
      ['boxed numbers', Object(1), Object(1)],
      ['array lengths', [1, 2], [1]],
      ['null and object', null, {}],
      ['string and number', '1', 1],
    ];
    for (const [name, a, b] of same) {
      it(`agrees with fast-deep-equal on ${name}`, () => {
        expect(jsonEqual(a, b)).to.eq(stockEqual(a, b));
      });
    }

    it('compares a value nested past the call stack depth Ajv survives', () => {
      const nest = (depth: number, leaf: number) => {
        let value: unknown = leaf;
        for (let i = 0; i < depth; i++) value = i % 2 ? [value] : { a: value };
        return value;
      };
      expect(jsonEqual(nest(20000, 1), nest(20000, 1))).to.eq(true);
      expect(jsonEqual(nest(20000, 1), nest(20000, 2))).to.eq(false);
      expect(safeAjv({}).validate({ type: 'array', uniqueItems: true }, [nest(20000, 1), nest(20000, 1)])).to.eq(false);
    });

    it('ends a cyclic value with a RangeError', () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      const b: Record<string, unknown> = {};
      b.self = b;
      expect(() => jsonEqual(a, b)).to.throw(RangeError);
    });
  });

  describe('through DataValidator', () => {
    let validator: DataValidator;
    let release: () => void;

    before(async () => {
      ({ validator, release } = await boot(SHIPPED));
    });

    after(() => release());

    const param = (e: IValidationError, name: string): unknown => (e.params as Record<string, unknown>)[name];
    const fields = (errors: IValidationError[] | null) => (errors ?? []).map((e) => [e.instancePath, e.keyword, e.params]);

    it('reports every missing required property', () => {
      const [, errors] = validator.tryValidate({ type: 'object', required: ['email', 'password', 'name'] }, {});
      expect(fields(errors)).to.deep.eq([
        ['', 'required', { missingProperty: 'email' }],
        ['', 'required', { missingProperty: 'password' }],
        ['', 'required', { missingProperty: 'name' }],
      ]);
    });

    it('reports every unknown property, dependency and property name', () => {
      const [, unknown] = validator.tryValidate({ type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1, x: 1, y: 2 });
      expect(fields(unknown)).to.deep.eq([
        ['', 'additionalProperties', { additionalProperty: 'x' }],
        ['', 'additionalProperties', { additionalProperty: 'y' }],
      ]);

      const [, dependencies] = validator.tryValidate({ type: 'object', dependencies: { a: ['b', 'c'] } }, { a: 1 });
      expect(dependencies!.map((e) => param(e, 'missingProperty'))).to.deep.eq(['b', 'c']);

      const [, names] = validator.tryValidate({ type: 'object', propertyNames: { maxLength: 1 } }, { ab: 1, cd: 2 });
      expect(names!.filter((e) => e.keyword === 'propertyNames').map((e) => param(e, 'propertyName'))).to.deep.eq(['ab', 'cd']);
    });

    it('ValidationFailed details keep every missing and unknown field', () => {
      const schema = { type: 'object', required: ['a', 'b', 'c'], properties: { a: {}, b: {}, c: {} }, additionalProperties: false };
      try {
        validator.validate(schema, { x: 1, y: 2 });
        expect.fail('validated');
      } catch (err) {
        expect(err).to.be.instanceOf(ValidationFailed);
        expect((err as ValidationFailed).parameter.map((e) => param(e, 'missingProperty') ?? param(e, 'additionalProperty'))).to.deep.eq(['a', 'b', 'c', 'x', 'y']);
      }
    });

    it('reports a non-finite number once, without the marker', () => {
      for (const data of [{ v: -Infinity }, { v: '-Infinity' }]) {
        const [, errors] = validator.tryValidate(P({ type: ['integer', 'null'], minimum: 0 }), data);
        expect(fields(errors), ser(data)).to.deep.eq([['/v', 'type', { type: ['integer', 'null'] }]]);
      }
    });

    it('a $data uniqueItems still follows the referenced flag', () => {
      const schema = SCHEMAS.dataUniq;
      expect(validator.tryValidate(schema, { a: true, b: [1, 1] })[0]).to.eq(false);
      expect(validator.tryValidate(schema, { a: false, b: [1, 1] })[0]).to.eq(true);
      expect(validator.tryValidate(schema, { a: true, b: [{ valueOf: 1 }, { valueOf: 1 }] })[0]).to.eq(false);
    });

    it('uniqueItems reports wrong-typed items through items only', () => {
      const [, errors] = validator.tryValidate(SCHEMAS.uniqInt, ['x', 'x', 1]);
      expect(errors!.map((e) => e.keyword)).to.deep.eq(['type', 'type']);
    });

    describe('a non-finite number under a schema without a type', () => {
      for (const [name, schema] of [
        ['minimum and maximum', { minimum: 0, maximum: 10 }],
        ['minimum only', { minimum: 0 }],
        ['exclusiveMaximum', { exclusiveMaximum: 10 }],
        ['multipleOf', { multipleOf: 2 }],
      ] as const) {
        it(`${name} refuses a JSON 1e400, as a property and at the root`, () => {
          expect(validator.tryValidate(P(schema), JSON.parse('{"v":1e400}'))[0]).to.eq(false);
          expect(validator.tryValidate(P(schema), JSON.parse('{"v":-1e400}'))[0]).to.eq(false);
          expect(validator.tryValidate(schema, Infinity as unknown as object)[0]).to.eq(false);
        });
      }

      it('keeps the finite verdicts and refuses a non-finite number nested where no rule looks', () => {
        expect(validator.tryValidate(P({ minimum: 0, maximum: 10 }), { v: 5 })[0]).to.eq(true);
        expect(validator.tryValidate(P({ minimum: 0, maximum: 10 }), { v: 11 })[0]).to.eq(false);
        expect(validator.tryValidate(P({ minimum: 0, maximum: 10 }), { v: 'Infinity' })[0]).to.eq(true);
        const [valid, errors] = validator.tryValidate(P({ minimum: 0 }), { v: [1, Infinity] });
        expect(valid).to.eq(false);
        expect(errors!.map((e) => [e.instancePath, e.keyword, e.schemaPath])).to.deep.eq([['/v/1', 'type', '#']]);
      });
    });
  });
});
