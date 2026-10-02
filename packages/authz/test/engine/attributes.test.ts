import * as chai from 'chai';
import 'mocha';

import { mergeAttributes, schemaIndex } from '../../src/engine/attributes.js';
import { AuthzConfigError } from '../../src/contracts/errors.js';
import type { ScopeAttributeSchema } from '../../src/index.js';

const expect = chai.expect;

function isDeepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => isDeepFrozen(x, seen));
}

function nest(levels: number): Record<string, unknown> {
  let v: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < levels; i++) v = { a: v };
  return v;
}

describe('engine attributes: mergeAttributes', () => {
  it('returns a frozen empty object for no layers', () => {
    const out = mergeAttributes([]);
    expect(out).to.deep.equal({});
    expect(Object.isFrozen(out)).to.equal(true);
  });

  it('merges plain objects recursively, later layers win', () => {
    const out = mergeAttributes([{ a: 1, p: { x: 1, y: 2, q: { k: 'd' } } }, { p: { y: 3, z: 4, q: { j: 'r' } } }, { b: 2, p: { x: 'store' } }]);
    expect(out).to.deep.equal({ a: 1, b: 2, p: { x: 'store', y: 3, z: 4, q: { k: 'd', j: 'r' } } });
  });

  it('replaces scalars, null and objects in either direction', () => {
    expect(mergeAttributes([{ a: { x: 1 } }, { a: 5 }])).to.deep.equal({ a: 5 });
    expect(mergeAttributes([{ a: 5 }, { a: { x: 1 } }])).to.deep.equal({ a: { x: 1 } });
    expect(mergeAttributes([{ a: { x: 1 } }, { a: null }])).to.deep.equal({ a: null });
    expect(mergeAttributes([{ a: true }, { a: 'no' }])).to.deep.equal({ a: 'no' });
  });

  it('replaces arrays instead of concatenating, and copies them', () => {
    const list = ['x', { k: 1 }];
    const out = mergeAttributes([{ l: [1, 2, 3] }, { l: list }]);
    expect(out).to.deep.equal({ l: ['x', { k: 1 }] });
    expect(out.l).to.not.equal(list);
    (list[1] as Record<string, unknown>).k = 2;
    list.push('y');
    expect(out).to.deep.equal({ l: ['x', { k: 1 }] });
  });

  it('merges an array over an object and an object over an array by replacing', () => {
    expect(mergeAttributes([{ a: { x: 1 } }, { a: [1] }])).to.deep.equal({ a: [1] });
    expect(mergeAttributes([{ a: [1] }, { a: { x: 1 } }])).to.deep.equal({ a: { x: 1 } });
  });

  it('skips __proto__, prototype and constructor keys at every level', () => {
    const layer = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":2,"ok":1,"n":{"__proto__":{"p":1},"v":2}}');
    const out = mergeAttributes([layer]);
    expect(Object.keys(out)).to.deep.equal(['ok', 'n']);
    expect(Object.getPrototypeOf(out)).to.equal(Object.prototype);
    expect(Object.keys(out.n as object)).to.deep.equal(['v']);
    expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
    expect((out as Record<string, unknown>).polluted).to.equal(undefined);
  });

  it('skips undefined values, keeping the earlier layer', () => {
    expect(
      mergeAttributes([
        { a: 1, p: { x: 1 } },
        { a: undefined, p: { x: undefined } },
      ]),
    ).to.deep.equal({ a: 1, p: { x: 1 } });
  });

  // Dropping, not keeping the earlier value: a default must not show through an override the engine cannot read.
  for (const [name, bad] of [
    ['function', () => 1],
    ['class instance', new (class Foo {})()],
    ['Map', new Map()],
    ['symbol', Symbol('s')],
    ['bigint', BigInt(1)],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['invalid Date', new Date('nope')],
    ['array with a function', [1, () => 1]],
    ['array with a hole', [1, , 3]],
    ['array with undefined', [1, undefined]],
  ] as [string, unknown][]) {
    it(`drops a key whose value is a ${name}, also from earlier layers`, () => {
      const out = mergeAttributes([{ k: true, keep: 1 }, { k: bad }]);
      expect(Object.hasOwn(out, 'k')).to.equal(false);
      expect(out).to.deep.equal({ keep: 1 });
    });
  }

  it('drops a nested key with a bad value but keeps its siblings', () => {
    expect(mergeAttributes([{ p: { a: 1, b: 2 } }, { p: { b: () => 1, c: 3 } }])).to.deep.equal({ p: { a: 1, c: 3 } });
  });

  it('reads each property once, and drops a key whose getter throws', () => {
    let reads = 0;
    const layer = {};
    Object.defineProperty(layer, 'g', {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? 'first' : 'later';
      },
    });
    Object.defineProperty(layer, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    const out = mergeAttributes([{ boom: 'default' }, layer]);
    expect(reads).to.equal(1);
    expect(out).to.deep.equal({ g: 'first' });
  });

  it('accepts null-prototype objects as layers and nested values', () => {
    const layer = Object.assign(Object.create(null), { a: 1, p: Object.assign(Object.create(null), { x: 2 }) });
    const out = mergeAttributes([{ p: { y: 1 } }, layer]);
    expect(out).to.deep.equal({ a: 1, p: { y: 1, x: 2 } });
  });

  it('stores a valid Date as its ISO string, which no reader can change', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    const out = mergeAttributes([{ at: d, l: [d] }]);
    expect(out).to.deep.equal({ at: '2026-01-02T03:04:05.000Z', l: ['2026-01-02T03:04:05.000Z'] });
    d.setFullYear(2000);
    expect(out.at).to.equal('2026-01-02T03:04:05.000Z');
  });

  it('returns a fresh deep-frozen object and never mutates or keeps a layer', () => {
    const inner = { x: 1 };
    const layer = { p: inner, l: [inner] };
    const out = mergeAttributes([layer]);
    expect(out).to.not.equal(layer);
    expect(out.p).to.not.equal(inner);
    expect((out.l as unknown[])[0]).to.not.equal(inner);
    expect(isDeepFrozen(out)).to.equal(true);
    expect(Object.isFrozen(layer)).to.equal(false);
    expect(layer).to.deep.equal({ p: { x: 1 }, l: [{ x: 1 }] });
  });

  it('accepts frozen layers', () => {
    const layer = Object.freeze({ p: Object.freeze({ x: 1 }) });
    expect(mergeAttributes([layer, { p: { y: 2 } }])).to.deep.equal({ p: { x: 1, y: 2 } });
    expect(layer).to.deep.equal({ p: { x: 1 } });
  });

  for (const [name, layer] of [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 1],
    ['an array', [{ a: 1 }]],
    ['a Date', new Date()],
    ['a class instance', new (class Foo {})()],
    ['a function', () => ({})],
  ] as [string, unknown][]) {
    it(`throws AuthzConfigError for a layer that is ${name}`, () => {
      expect(() => mergeAttributes([{ a: 1 }, layer])).to.throw(AuthzConfigError);
    });
  }

  it('throws AuthzConfigError when layers is not an array', () => {
    expect(() => mergeAttributes({} as unknown as unknown[])).to.throw(AuthzConfigError);
  });

  it('throws AuthzConfigError for a layer whose keys cannot be read', () => {
    const layer = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(() => mergeAttributes([layer])).to.throw(AuthzConfigError);
  });

  it('drops a nested key whose object or list cannot be read, also from earlier layers', () => {
    const trap = (target: object, trapName: 'ownKeys' | 'get') =>
      new Proxy(target, {
        [trapName]() {
          throw new Error('trap');
        },
      });
    const out = mergeAttributes([
      { p: { a: 1 }, l: [1], keep: 1 },
      { p: trap({ x: 1 }, 'ownKeys'), l: trap([1, 2], 'get') },
    ]);
    expect(out).to.deep.equal({ keep: 1 });
  });

  it('throws AuthzConfigError on a cycle, in objects and in arrays', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => mergeAttributes([a])).to.throw(AuthzConfigError);
    const b: Record<string, unknown> = {};
    b.l = [b];
    expect(() => mergeAttributes([b])).to.throw(AuthzConfigError);
  });

  it('accepts nesting up to 32 levels and throws AuthzConfigError beyond', () => {
    expect(() => mergeAttributes([nest(32)])).to.not.throw();
    expect(() => mergeAttributes([nest(33)])).to.throw(AuthzConfigError);
  });

  it('counts arrays as nesting levels', () => {
    const lists = (levels: number): unknown => {
      let v: unknown = 1;
      for (let i = 1; i < levels; i++) v = [v];
      return v;
    };
    // The layer is level 1, so lists(n) reaches level n.
    expect(() => mergeAttributes([{ l: lists(32) }])).to.not.throw();
    expect(() => mergeAttributes([{ l: lists(33) }])).to.throw(AuthzConfigError);
  });

  it('throws AuthzConfigError fast for a list claiming 2^32-1 elements', () => {
    const huge = new Proxy([], {
      get(target, key) {
        return key === 'length' ? 2 ** 32 - 1 : typeof key === 'string' && /^\d+$/.test(key) ? 'x' : Reflect.get(target, key);
      },
      has(target, key) {
        return (typeof key === 'string' && /^\d+$/.test(key)) || Reflect.has(target, key);
      },
    });
    const started = Date.now();
    expect(() => mergeAttributes([{ l: huge }])).to.throw(AuthzConfigError);
    expect(Date.now() - started).to.be.lessThan(5000);
  });

  it('throws AuthzConfigError fast for a layer with 20,000 scalar keys', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) wide[`k${i}`] = i;
    const started = Date.now();
    expect(() => mergeAttributes([wide])).to.throw(AuthzConfigError);
    expect(Date.now() - started).to.be.lessThan(5000);
  });

  it('counts the value budget across all layers of one merge', () => {
    const half: Record<string, unknown> = {};
    for (let i = 0; i < 6_000; i++) half[`k${i}`] = i;
    expect(() => mergeAttributes([half])).to.not.throw();
    expect(() => mergeAttributes([half, half])).to.throw(AuthzConfigError);
  });

  it('accepts a shared subtree that is not a cycle', () => {
    const shared = { x: 1 };
    expect(mergeAttributes([{ a: shared, b: shared }])).to.deep.equal({ a: { x: 1 }, b: { x: 1 } });
  });

  it('throws AuthzConfigError fast on a shared-subtree layer that would expand exponentially', () => {
    let v: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) v = { l: v, r: v };
    const started = Date.now();
    expect(() => mergeAttributes([v])).to.throw(AuthzConfigError);
    expect(Date.now() - started).to.be.lessThan(5000);
  });
});

describe('engine attributes: schemaIndex', () => {
  const schema = (scopeType: string, defaults: Record<string, unknown>): ScopeAttributeSchema => ({ scopeType, schema: {}, defaults });

  it('returns an empty map for no schemas', () => {
    expect(schemaIndex(undefined).size).to.equal(0);
    expect(schemaIndex([]).size).to.equal(0);
  });

  it('indexes defaults by scope type as frozen copies', () => {
    const defaults = { policies: { public_links: false }, tags: ['a'] };
    const index = schemaIndex([schema('org', defaults), schema('branch', { name: 'main' })]);
    expect([...index.keys()]).to.deep.equal(['org', 'branch']);
    expect(index.get('org')).to.deep.equal({ policies: { public_links: false }, tags: ['a'] });
    expect(index.get('org')).to.not.equal(defaults);
    expect(isDeepFrozen(index.get('org'))).to.equal(true);
    defaults.policies.public_links = true;
    expect(index.get('org')).to.deep.equal({ policies: { public_links: false }, tags: ['a'] });
  });

  it('throws AuthzConfigError naming the type for two schemas of one type', () => {
    expect(() => schemaIndex([schema('org', {}), schema('branch', {}), schema('org', { a: 1 })]))
      .to.throw(AuthzConfigError)
      .with.property('message')
      .that.contains('org');
  });

  for (const [name, input] of [
    ['a non-array', {}],
    ['a null entry', [null]],
    ['a string entry', ['org']],
    ['a missing scopeType', [{ schema: {}, defaults: {} }]],
    ['an empty scopeType', [{ scopeType: '', schema: {}, defaults: {} }]],
    ['a numeric scopeType', [{ scopeType: 1, schema: {}, defaults: {} }]],
    ['missing defaults', [{ scopeType: 'org', schema: {} }]],
    ['array defaults', [{ scopeType: 'org', schema: {}, defaults: [] }]],
    ['class-instance defaults', [{ scopeType: 'org', schema: {}, defaults: new Map() }]],
    [
      'defaults whose prototype trap throws',
      [
        {
          scopeType: 'org',
          schema: {},
          defaults: new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error('trap');
              },
            },
          ),
        },
      ],
    ],
    [
      'an entry whose scopeType getter throws',
      [
        {
          get scopeType() {
            throw new Error('getter');
          },
          schema: {},
          defaults: {},
        },
      ],
    ],
  ] as [string, unknown][]) {
    it(`throws AuthzConfigError for ${name}`, () => {
      expect(() => schemaIndex(input as ScopeAttributeSchema[])).to.throw(AuthzConfigError);
    });
  }
});
