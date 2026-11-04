import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { Ajv } from 'ajv';
import {
  additionalProperties,
  contains,
  dataLimit,
  dataRef,
  dependencies,
  maxProperties,
  minProperties,
  patternProperties,
  propertyNames,
} from '../../src/formats/index.js';
import { describeInput, serverAjv } from './server-ajv.js';

const OBJECTS: unknown[] = [null, 1, 'a', [], [1], {}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { x1: 1 }, { x1: 'a', a: 'b' }, { toString: 1 }, JSON.parse('{"__proto__":1}'), JSON.parse('{"a":1,"__proto__":"p"}'), { 'x-a': 1, b: true }];

const objects = fc.oneof(fc.constantFrom(...OBJECTS), fc.dictionary(fc.constantFrom('a', 'b', 'c', 'x1', 'x2', 'toString', '__proto__'), fc.oneof(fc.integer({ min: -2, max: 2 }), fc.constantFrom('a', '', null, true)), { maxKeys: 4 }));

describe('@spinajs/client/formats: applicator and object keyword helpers', function () {
  this.timeout(60000);

  const ajv = serverAjv(false);
  const test = (schema: object) => {
    const validate = ajv.compile(schema);
    return (value: unknown) => validate(value);
  };
  const agree = (ours: (value: unknown) => boolean, schema: object) => {
    const server = ajv.compile(schema);
    for (const value of OBJECTS) expect(ours(value), `${JSON.stringify(schema)} ${describeInput(value)}`).to.equal(server(value));
    fc.assert(fc.property(objects, (value) => ours(value) === server(value)), { numRuns: 500 });
  };

  it('minProperties and maxProperties count own keys, a JSON __proto__ key included', () => {
    for (const n of [0, 1, 2, 3]) {
      agree(minProperties(n), { minProperties: n });
      agree(maxProperties(n), { maxProperties: n });
    }
  });

  it('propertyNames checks every own key', () => {
    agree(propertyNames(test({ pattern: '^[a-c]$' })), { propertyNames: { pattern: '^[a-c]$' } });
    agree(propertyNames(test({ maxLength: 1 })), { propertyNames: { maxLength: 1 } });
  });

  it('patternProperties checks each value whose key matches, against every matching pattern', () => {
    const patterns: [RegExp, (value: unknown) => boolean][] = [
      [/^x/u, test({ type: 'string' })],
      [/1$/u, test({ minLength: 1 })],
    ];
    agree(patternProperties(patterns), { patternProperties: { '^x': { type: 'string' }, '1$': { minLength: 1 } } });
  });

  it('additionalProperties skips declared and pattern keys, and refuses or checks the others', () => {
    agree(additionalProperties(['a'], [/^x/u]), { properties: { a: true }, patternProperties: { '^x': true }, additionalProperties: false });
    agree(additionalProperties(['a'], [/^x/u], test({ type: 'integer' })), { properties: { a: true }, patternProperties: { '^x': true }, additionalProperties: { type: 'integer' } });
  });

  it('dependencies reads properties as Ajv does, inherited ones included', () => {
    agree(dependencies({ a: ['b'], toString: ['c'] }), { dependencies: { a: ['b'], toString: ['c'] } });
    agree(dependencies({ b: test({ required: ['c'] }) }), { dependencies: { b: { required: ['c'] } } });
  });

  it('contains needs one matching item, and passes what is not an array', () => {
    const ours = contains(test({ type: 'string' }));
    const server = ajv.compile({ contains: { type: 'string' } });
    for (const value of [[], [1], [1, 'a'], 'a', {}, null]) expect(ours(value), describeInput(value)).to.equal(server(value));
  });

  describe('$data', () => {
    const dataAjv = new Ajv({ strict: false, strictNumbers: true, allErrors: true, $data: true });

    it('dataRef reads a pointer as Ajv does: a falsy step ends the walk with that value', () => {
      expect(dataRef({ a: { b: 2 } }, ['a', 'b'])).to.equal(2);
      expect(dataRef({ a: 0 }, ['a', 'b'])).to.equal(0);
      expect(dataRef({ a: null }, ['a', 'b'])).to.equal(null);
      expect(dataRef({}, ['a'])).to.equal(undefined);
      expect(dataRef({ a: [5] }, ['a', '0'])).to.equal(5);
    });

    const KEYWORDS = ['const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const;
    const VALUES: unknown[] = [undefined, null, 0, 1, 2, 2.5, -1, '', 'ab', 'abc', '😀😀', [], [1], [1, 2], {}, { a: 1 }, { a: 1, b: 2 }, true];

    for (const keyword of KEYWORDS) {
      it(`dataLimit answers as ${keyword} with $data`, () => {
        const validate = dataAjv.compile({ type: 'object', properties: { v: { [keyword]: { $data: '1/r' } } } });
        for (const value of VALUES) {
          for (const ref of VALUES) {
            const data: Record<string, unknown> = {};
            if (value !== undefined) data.v = value;
            if (ref !== undefined) data.r = ref;
            expect(dataLimit(keyword, value, ref), `${keyword} ${describeInput(value)} against ${describeInput(ref)}`).to.equal(validate(structuredClone(data)));
          }
        }
      });
    }
  });
});
