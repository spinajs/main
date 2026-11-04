import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { ajvEqual, ajvMultipleOf, ajvUniqueItems, maxCodePoints, minCodePoints, type JsonType } from '../../src/formats/index.js';
import { describeInput, serverAjv } from './server-ajv.js';

const LENGTH_CORPUS = ['', 'a', 'ab', 'é', 'é', '😀', '😀😀', '\ud83d', '\ude00', '\ude00\ud83d', 'a\ud83d', '👨‍👩‍👧', '🇵🇱', 'x😀y'];

const JSON_CORPUS: unknown[] = [null, true, false, 0, -0, 1, 1.5, '', '0', 'a', [], [0], [-0], [1, 2], [2, 1], {}, { a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 }, { a: [1, { b: null }] }, { a: undefined }, [[]], [{}], { '': 0 }, { valueOf: 1 }, { toString: false },
  // fast-deep-equal walks keys from the end: the key order decides whether it throws or answers false first.
  { x: { valueOf: 1 }, y: 1 }, { x: { a: 1 }, y: 2 }, { y: 1, x: { valueOf: 1 } }, { y: 2, x: { a: 1 } }];

/** A verdict, or 'throws': fast-deep-equal, and so Ajv, throws on data with an own non-function valueOf or toString. */
function outcome(run: () => boolean): boolean | 'throws' {
  try {
    return run();
  } catch {
    return 'throws';
  }
}

/** Objects that mix own `valueOf`/`toString` keys with other keys, at any depth. */
function trickyObjects(): fc.Arbitrary<unknown> {
  const key = fc.constantFrom('valueOf', 'toString', 'a', 'b', 'x');
  const leaf = fc.constantFrom<unknown>(1, 2, false, null, 'a');
  return fc.letrec<{ node: unknown }>((tie) => ({
    node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leaf, fc.dictionary(key, tie('node'), { maxKeys: 3, noNullPrototype: true }), fc.array(tie('node'), { maxLength: 2 })),
  })).node;
}

function json(): fc.Arbitrary<unknown> {
  return fc.oneof(fc.constantFrom(...JSON_CORPUS), fc.jsonValue({ maxDepth: 3 }), trickyObjects());
}

describe('@spinajs/client/formats: keyword helpers', function () {
  // fast-check runs thousands of cases; mocha's 2 s default under --no-config is too short on a loaded machine.
  this.timeout(60000);

  const ajv = serverAjv(false);
  const strings = fc.oneof(fc.constantFrom(...LENGTH_CORPUS), fc.string({ unit: 'binary', maxLength: 8 }), fc.string({ unit: 'grapheme', maxLength: 6 }));

  it('minCodePoints and maxCodePoints count as minLength and maxLength do', () => {
    for (let n = 0; n <= 6; n++) {
      const min = ajv.compile({ minLength: n });
      const max = ajv.compile({ maxLength: n });
      for (const input of LENGTH_CORPUS) {
        expect(minCodePoints(n)(input), `minLength ${n} ${describeInput(input)}`).to.equal(min(input));
        expect(maxCodePoints(n)(input), `maxLength ${n} ${describeInput(input)}`).to.equal(max(input));
      }
      fc.assert(fc.property(strings, (input) => minCodePoints(n)(input) === min(input) && maxCodePoints(n)(input) === max(input)));
    }
  });

  it('count a surrogate pair once and a lone surrogate once, unlike String#length', () => {
    expect(maxCodePoints(1)('😀')).to.be.true;
    expect(minCodePoints(2)('😀')).to.be.false;
    expect(minCodePoints(2)('\ude00\ud83d')).to.be.true;
  });

  it('ajvMultipleOf answers as multipleOf', () => {
    const divisors = [1, 2, 3, 0.1, 0.01, 0.5, 1.5, 1e-7, 7, 1e21, 2 ** -20];
    const values = [0, -0, 1, 0.3, 0.30000000000000004, 1.1, 1e21, 1e22, -4.5, 3e-7, 2 ** 53, 123.456, 1e-7];
    for (const divisor of divisors) {
      const check = ajv.compile({ multipleOf: divisor });
      const predicate = ajvMultipleOf(divisor);
      for (const value of values) {
        expect(predicate(value), `${value} multipleOf ${divisor}`).to.equal(check(value));
      }
      const numbers = fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer().map((n) => n * divisor), fc.integer().map((n) => n / 10));
      fc.assert(fc.property(numbers, (value) => predicate(value) === check(value)));
    }
  });

  it('ajvMultipleOf keeps the quirks of parseInt on large quotients', () => {
    expect(ajvMultipleOf(1)(1e21)).to.be.false;
    expect(ajvMultipleOf(0.1)(0.3)).to.be.false;
    expect(ajvMultipleOf(0)(0)).to.be.false;
  });

  it('ajvEqual answers as const and enum', () => {
    for (const expected of JSON_CORPUS) {
      const asConst = ajv.compile({ const: expected });
      const asEnum = ajv.compile({ enum: [expected, '\u0000sentinel'] });
      for (const input of JSON_CORPUS) {
        const label = `${describeInput(expected)} vs ${describeInput(input)}`;
        const ours = outcome(() => ajvEqual(input, expected));
        expect(ours, label).to.equal(outcome(() => asConst(input)));
        expect(ours, label).to.equal(outcome(() => asEnum(input)));
      }
    }
    fc.assert(
      fc.property(json(), json(), (expected, input) => outcome(() => ajvEqual(input, expected)) === outcome(() => ajv.compile({ const: expected })(input))),
      { numRuns: 500 },
    );
    fc.assert(fc.property(json(), (value) => outcome(() => ajvEqual(value, structuredClone(value))) !== false));
  });

  it('ajvEqual throws where Ajv throws: on data with an own valueOf or toString key', () => {
    expect(() => ajv.compile({ const: { a: 1 } })({ valueOf: 1 })).to.throw(TypeError);
    expect(() => ajvEqual({ valueOf: 1 }, { a: 1 })).to.throw(TypeError);
    expect(() => ajvEqual({ toString: false }, { a: 1 })).to.throw(TypeError);
    expect(ajvEqual({ a: 1 }, { valueOf: 1 })).to.be.false;
  });

  it('ajvEqual treats 0 and -0 as equal and ignores key order', () => {
    expect(ajvEqual(0, -0)).to.be.true;
    expect(ajvEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).to.be.true;
    expect(ajvEqual([1, 2], [2, 1])).to.be.false;
  });

  it('ajvEqual treats NaN as equal to NaN, as uniqueItems on non-JSON data shows', () => {
    const unique = ajv.compile({ uniqueItems: true });
    expect(unique([NaN, NaN])).to.be.false;
    expect(ajvEqual(NaN, NaN)).to.be.true;
    expect(ajvUniqueItems([NaN, NaN])).to.be.false;
  });

  describe('ajvUniqueItems', () => {
    const ITEM_TYPES: (JsonType[] | undefined)[] = [undefined, ['string'], ['number'], ['integer'], ['boolean'], ['null'], ['string', 'null'], ['number', 'string'], ['integer', 'boolean', 'null'], ['object'], ['array'], ['string', 'object']];
    const ARRAYS: unknown[][] = [[], [1], [1, 1], [1, '1'], ['1', '1'], [0, -0], [null, 'null'], [null, null], [true, 'true'], [true, true], [{ a: 1 }, { a: 1 }], [[1], [1]], [{ a: 1 }, { a: 2 }], ['__proto__', '__proto__'], ['constructor', 'constructor'], ['toString', 'toString'], [1.5, 1.5], ['a', 'b', 'a'], [{ a: 1 }, { valueOf: 1 }], [{ valueOf: 1 }, { a: 1 }]];
    const items = fc.oneof(fc.constantFrom(...ARRAYS), fc.array(fc.oneof(fc.constantFrom(null, true, false, 0, 1, '', 'a', '1', '__proto__'), fc.integer({ min: -2, max: 2 }), fc.jsonValue({ maxDepth: 1 }), trickyObjects()), { maxLength: 6 }));

    for (const itemTypes of ITEM_TYPES) {
      it(`answers as uniqueItems with items of type ${JSON.stringify(itemTypes ?? 'any')}`, () => {
        const itemSchema = itemTypes ? { items: { type: itemTypes } } : {};
        const typed = ajv.compile({ type: 'array', ...itemSchema });
        const unique = ajv.compile({ type: 'array', ...itemSchema, uniqueItems: true });
        // Ajv skips items of the wrong type in its hashing shortcut; those fail `items` anyway.
        const agrees = (input: unknown[]): boolean => !typed(input) || outcome(() => ajvUniqueItems(input, itemTypes)) === outcome(() => unique(input));
        for (const input of ARRAYS) {
          expect(agrees(input), describeInput(input)).to.be.true;
        }
        fc.assert(fc.property(items, agrees), { numRuns: 1000 });
      });
    }

    it('lets repeated "__proto__" strings through when Ajv hashes string items', () => {
      expect(ajvUniqueItems(['__proto__', '__proto__'], ['string'])).to.be.true;
      expect(ajvUniqueItems(['__proto__', '__proto__'])).to.be.false;
    });
  });
});
