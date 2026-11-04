import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { ajvEqual, ajvMultipleOf, ajvUniqueItems, maxCodePoints, minCodePoints, uniqueItemProperties, type JsonType } from '../../src/formats/index.js';
import { describeInput, serverAjv } from './server-ajv.js';

const LENGTH_CORPUS = ['', 'a', 'ab', 'é', 'é', '😀', '😀😀', '\ud83d', '\ude00', '\ude00\ud83d', 'a\ud83d', '👨‍👩‍👧', '🇵🇱', 'x😀y'];

const JSON_CORPUS: unknown[] = [null, true, false, 0, -0, 1, 1.5, '', '0', 'a', [], [0], [-0], [1, 2], [2, 1], {}, { a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 }, { a: [1, { b: null }] }, { a: undefined }, [[]], [{}], { '': 0 }, { valueOf: 1 }, { toString: false },
  // fast-deep-equal walks keys from the end: the key order decides whether it throws or answers false first.
  { x: { valueOf: 1 }, y: 1 }, { x: { a: 1 }, y: 2 }, { y: 1, x: { valueOf: 1 } }, { y: 2, x: { a: 1 } }];

/** A verdict, or 'throws': fast-deep-equal, and so stock Ajv, throws on data with an own non-function valueOf or toString. */
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

/** Deep equality over own keys, where a JSON value's own `valueOf` or `toString` key is data. */
function ownKeysEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && ownKeysEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
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

  // The server's fixed comparison (`jsonEqual` in @spinajs/validation): stock Ajv's answer where it has one, else own keys.
  const reference = (a: unknown, b: unknown): boolean => {
    const stock = outcome(() => ajv.compile({ const: b })(a));
    return stock === 'throws' ? ownKeysEqual(a, b) : stock;
  };

  it('ajvEqual answers as const and enum, and never throws', () => {
    for (const expected of JSON_CORPUS) {
      for (const input of JSON_CORPUS) {
        expect(outcome(() => ajvEqual(input, expected)), `${describeInput(expected)} vs ${describeInput(input)}`).to.equal(reference(input, expected));
      }
    }
    fc.assert(
      fc.property(json(), json(), (expected, input) => outcome(() => ajvEqual(input, expected)) === reference(input, expected)),
      { numRuns: 500 },
    );
    fc.assert(fc.property(json(), (value) => ajvEqual(value, structuredClone(value))));
  });

  it('ajvEqual compares own valueOf and toString keys as data, where stock Ajv throws', () => {
    expect(() => ajv.compile({ const: { a: 1 } })({ valueOf: 1 })).to.throw(TypeError);
    expect(ajvEqual({ valueOf: 1 }, { a: 1 })).to.be.false;
    expect(ajvEqual({ valueOf: 1 }, { valueOf: 1 })).to.be.true;
    expect(ajvEqual({ toString: false }, { toString: false })).to.be.true;
  });

  it('ajvEqual compares values nested deeper than the call stack', () => {
    const deep = (n: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < n; i++) value = [value];
      return value;
    };
    expect(ajvEqual(deep(20000), deep(20000))).to.be.true;
    expect(ajvEqual(deep(20000), deep(20001))).to.be.false;
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
    const ARRAYS: unknown[][] = [[], [1], [1, 1], [1, '1'], ['1', '1'], [0, -0], [null, 'null'], [null, null], [true, 'true'], [true, true], [{ a: 1 }, { a: 1 }], [[1], [1]], [{ a: 1 }, { a: 2 }], ['__proto__', '__proto__'], ['constructor', 'constructor'], ['toString', 'toString'], [1.5, 1.5], ['a', 'b', 'a'], [{ a: 1 }, { valueOf: 1 }], [{ valueOf: 1 }, { a: 1 }], [{ valueOf: 1 }, { valueOf: 1 }]];
    const items = fc.oneof(fc.constantFrom(...ARRAYS), fc.array(fc.oneof(fc.constantFrom(null, true, false, 0, 1, '', 'a', '1', '__proto__'), fc.integer({ min: -2, max: 2 }), fc.jsonValue({ maxDepth: 1 }), trickyObjects()), { maxLength: 6 }));
    // Pairwise, as the fixed server compares items; it skips items of another declared type, which fail `items` anyway.
    const pairwise = (input: unknown[]): boolean => input.every((x, i) => input.every((y, j) => j <= i || !reference(x, y)));

    for (const itemTypes of ITEM_TYPES) {
      it(`answers as uniqueItems with items of type ${JSON.stringify(itemTypes ?? 'any')}`, () => {
        const typed = ajv.compile({ type: 'array', ...(itemTypes ? { items: { type: itemTypes } } : {}) });
        const agrees = (input: unknown[]): boolean => !typed(input) || ajvUniqueItems(input) === pairwise(input);
        for (const input of ARRAYS) {
          expect(agrees(input), describeInput(input)).to.be.true;
        }
        fc.assert(fc.property(items, agrees), { numRuns: 1000 });
      });
    }

    it('counts repeated "__proto__" strings and own valueOf keys as duplicates, as the fixed server does', () => {
      expect(ajvUniqueItems(['__proto__', '__proto__'])).to.be.false;
      expect(ajvUniqueItems([{ valueOf: 1 }, { valueOf: 1 }])).to.be.false;
      expect(ajvUniqueItems([0, -0])).to.be.false;
      expect(ajvUniqueItems([1, '1', true, 'true', null, 'null'])).to.be.true;
    });
  });

  it('uniqueItemProperties compares scalar properties by value and the others deeply', () => {
    const scalar = uniqueItemProperties(['id'], [true]);
    expect(scalar([{ id: 1 }, { id: '1' }])).to.be.true;
    expect(scalar([{ id: 1 }, { id: 1 }])).to.be.false;
    expect(scalar([{ id: 1 }, 5, { x: 1 }, { x: 2 }])).to.be.false;
    const deep = uniqueItemProperties(['tags'], [false]);
    expect(deep([{ tags: { valueOf: 1 } }, { tags: { valueOf: 2 } }])).to.be.true;
    expect(deep([{ tags: [1] }, { tags: [1] }])).to.be.false;
  });
});
