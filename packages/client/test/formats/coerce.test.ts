import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { ajvCoerce, coerceArray, coerceBoolean, coerceInteger, coerceNull, coerceNumber, coerceString, type JsonType } from '../../src/formats/index.js';
import { describeInput, serverAjv } from './server-ajv.js';

const VALUES: unknown[] = [
  '', ' ', '\t1\n', '0', '-0', '1', '01', '1.5', '-1.5', '1e3', '0x10', '0b11', 'Infinity', '-Infinity', 'NaN', 'true', 'false', 'TRUE', 'null', 'abc', '1abc',
  0, -0, 1, -1, 1.5, true, false, null,
  [], ['1'], ['1.5'], ['true'], ['false'], [''], [1], [0], [true], [null], [[1]], ['a', 'b'], [{}], {}, { a: 1 },
];

const TYPES: JsonType[][] = [
  ['string'], ['number'], ['integer'], ['boolean'], ['null'], ['array'], ['object'],
  ['number', 'null'], ['string', 'null'], ['integer', 'boolean'], ['boolean', 'number'], ['null', 'boolean'], ['number', 'string'], ['string', 'number'],
  ['integer', 'number'], ['array', 'object'], ['array', 'object', 'null'], ['array', 'string'], ['object', 'null'], ['number', 'array'],
];

function inputs(): fc.Arbitrary<unknown> {
  const scalar = fc.oneof(fc.constantFrom(...VALUES), fc.string({ maxLength: 6 }), fc.double().map(String), fc.integer().map(String), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null));
  return fc.oneof(scalar, fc.array(scalar, { maxLength: 2 }), fc.jsonValue({ maxDepth: 2 }));
}

/** Whether Ajv `coerceTypes: 'array'` accepts the value, and what it leaves in the parent object. */
function serverCoerce(validate: (data: unknown) => boolean, input: unknown): { valid: boolean; value: unknown } {
  const data = { v: structuredClone(input) };
  return { valid: validate(data), value: data.v };
}

describe('@spinajs/client/formats: coercion', function () {
  // fast-check runs thousands of cases; mocha's 2 s default under --no-config is too short on a loaded machine.
  this.timeout(60000);

  const ajv = serverAjv(true);

  for (const types of TYPES) {
    it(`ajvCoerce(value, ${JSON.stringify(types)}) converts as coerceTypes 'array' does`, () => {
      const validate = ajv.compile({ type: 'object', properties: { v: { type: types } } });
      const agrees = (input: unknown): boolean => {
        const server = serverCoerce(validate, input);
        const coerced = ajvCoerce(input, types);
        if (!server.valid) {
          expect(coerced, `${describeInput(input)} fails on the server and is returned unchanged`).to.equal(input);
          return true;
        }
        expect(coerced, `${describeInput(input)} -> ${describeInput(server.value)}`).to.deep.equal(server.value);
        return true;
      };
      for (const input of VALUES) {
        agrees(input);
      }
      fc.assert(fc.property(inputs(), agrees), { numRuns: 1000 });
    });
  }

  const SINGLE: [JsonType, (value: unknown) => unknown][] = [
    ['string', coerceString],
    ['number', coerceNumber],
    ['integer', coerceInteger],
    ['boolean', coerceBoolean],
    ['null', coerceNull],
    ['array', coerceArray],
  ];
  for (const [type, coerce] of SINGLE) {
    it(`coerce${type[0].toUpperCase()}${type.slice(1)} is ajvCoerce with type ${type}`, () => {
      fc.assert(fc.property(inputs(), (input) => {
        expect(coerce(input)).to.deep.equal(ajvCoerce(input, [type]));
      }));
    });
  }

  it('keeps the server quirks a query string can hit', () => {
    expect(coerceNumber(' ')).to.equal(0);
    expect(coerceNumber('0x10')).to.equal(16);
    expect(coerceNumber('Infinity')).to.equal(Infinity);
    expect(coerceInteger('-Infinity')).to.equal(-Infinity);
    expect(coerceInteger('1.5')).to.equal('1.5');
    expect(coerceNumber(['2'])).to.equal(2);
    expect(coerceBoolean('TRUE')).to.equal('TRUE');
    expect(ajvCoerce([5], ['number', 'null'])).to.deep.equal([5]);
  });
});
