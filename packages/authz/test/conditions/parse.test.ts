import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import * as root from '../../src/index.js';
import { AuthzConfigError, CONDITION_SCHEMA, MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, MAX_CONDITION_VALUES, parseCondition } from '../../src/index.js';
import type { ParsedCondition } from '../../src/index.js';
import { FUNCTIONS, condition } from './arbitraries.js';

const expect = chai.expect;

const functions = new Set<string>(FUNCTIONS);
const parse = (c: unknown, where?: string): ParsedCondition => parseCondition(c, { functions, ...(where ? { where } : {}) });
const fails = (c: unknown, pattern: RegExp): void => {
  expect(() => parse(c, 'abac policy p1 when')).to.throw(AuthzConfigError, pattern);
};

const nest = (depth: number): unknown => {
  let c: unknown = { attr: 'resource.a', eq: 1 };
  for (let i = 0; i < depth; i++) c = { not: c };
  return c;
};

describe('conditions: parseCondition', () => {
  it('is exported from the package root with its schema and caps', () => {
    expect(root.parseCondition).to.be.a('function');
    expect(CONDITION_SCHEMA).to.be.frozen;
    expect(MAX_CONDITION_DEPTH).to.equal(32);
    expect(MAX_CONDITION_NODES).to.equal(1000);
    expect(MAX_CONDITION_VALUES).to.equal(10000);
  });

  describe('shapes', () => {
    it('parses all, any and not, keeping empty junctions', () => {
      const p = parse({ all: [{ any: [] }, { not: { all: [] } }] });
      expect(p.kind).to.equal('all');
      if (p.kind !== 'all') return;
      expect(p.items.map((i) => i.kind)).to.deep.equal(['any', 'not']);
    });

    it('rejects a node with two shapes, naming the extra key', () => {
      fails({ all: [], any: [] }, /unexpected key "any" at \(root\)/);
      fails({ not: { attr: 'resource.a', eq: 1 }, fn: 'glob' }, /unexpected key "fn"/);
    });

    it('rejects a node with no known shape', () => {
      fails({}, /needs one of all, any, not, attr, fn at \(root\)/);
      fails({ all: [{ foo: 1 }] }, /needs one of all, any, not, attr, fn at \.all\[0\]/);
    });

    it('rejects all/any that are not arrays and a not that is not a condition', () => {
      fails({ all: { attr: 'resource.a', eq: 1 } }, /must be array at \.all/);
      fails({ any: 'x' }, /must be array at \.any/);
      fails({ not: [] }, /at \.not/);
    });

    it('rejects non-object conditions', () => {
      for (const c of [null, 1, 'x', true, []]) fails(c, /must be object at \(root\)/);
    });

    it('prefixes messages with where, default "condition"', () => {
      expect(() => parseCondition({}, { functions })).to.throw(AuthzConfigError, /^condition: /);
      expect(() => parse({}, 'rbac rule r1 when')).to.throw(/^rbac rule r1 when: /);
    });
  });

  describe('attr nodes', () => {
    it('splits attr and ref into root and path', () => {
      const p = parse({ attr: 'resource.owner', eq: { ref: 'principal.attributes.pool' } });
      expect(p).to.deep.include({ kind: 'cmp', op: 'eq' });
      if (p.kind !== 'cmp') return;
      expect(p.attr).to.deep.equal({ root: 'resource', path: ['owner'], text: 'resource.owner' });
      expect(p.operand).to.deep.equal({ kind: 'ref', ref: { root: 'principal', path: ['attributes', 'pool'], text: 'principal.attributes.pool' } });
    });

    it('splits scope refs into type and path', () => {
      const p = parse({ attr: 'scope.org.policies.open', eq: true });
      if (p.kind !== 'cmp') throw new Error('cmp expected');
      expect(p.attr).to.deep.equal({ root: 'scope', scopeType: 'org', path: ['policies', 'open'], text: 'scope.org.policies.open' });
      expect(p.operand).to.deep.equal({ kind: 'literal', value: true });
    });

    it('accepts every operator with its operand kinds', () => {
      const ok: unknown[] = [
        { attr: 'resource.a', eq: 'x' },
        { attr: 'resource.a', eq: 1 },
        { attr: 'resource.a', eq: false },
        { attr: 'resource.a', eq: null },
        { attr: 'resource.a', ne: null },
        { attr: 'resource.a', in: ['a', 1] },
        { attr: 'resource.a', in: [] },
        { attr: 'resource.a', nin: { ref: 'principal.attributes.teams' } },
        { attr: 'resource.a', lt: 1 },
        { attr: 'resource.a', lte: 'b' },
        { attr: 'resource.a', gt: 3 },
        { attr: 'resource.a', gte: { ref: 'env.now' } },
        { attr: 'resource.a', like: 'a%' },
        { attr: 'resource.a', glob: 'x/**' },
        { attr: 'resource.a', wildcard: { ref: 'scope.org.prefix' } },
        { attr: 'resource.a', null: true },
        { attr: 'resource.a', null: false },
        { attr: 'principal.authn.assurance', eq: 'aal2' },
        { attr: 'actor.type', eq: 'agent' },
        { attr: 'env.ip', eq: { ref: 'actor.attributes.ip' } },
        { attr: 'scope.$global.flags.on', eq: true },
      ];
      for (const c of ok) expect(() => parse(c), JSON.stringify(c)).not.to.throw();
    });

    it('keeps eq null as a literal (UNKNOWN at runtime), not a null test', () => {
      const p = parse({ attr: 'resource.a', eq: null });
      expect(p).to.deep.include({ op: 'eq', operand: { kind: 'literal', value: null } });
    });

    it('needs exactly one operator', () => {
      fails({ attr: 'resource.a' }, /needs one operator \(eq, ne, in, nin, lt, lte, gt, gte, like, glob, wildcard, null\)/);
      fails({ attr: 'resource.a', eq: 1, ne: 2 }, /takes exactly one operator/);
      fails({ attr: 'resource.a', is: 1 }, /unexpected key "is"/);
    });

    it('checks the operand of each operator', () => {
      fails({ attr: 'resource.a', eq: [1] }, /'eq' takes a string, number, boolean, null or \{ref\} at \.eq/);
      fails({ attr: 'resource.a', in: 'a' }, /'in' takes a list of strings and numbers or \{ref\} at \.in/);
      fails({ attr: 'resource.a', nin: [true] }, /'nin' takes/);
      fails({ attr: 'resource.a', in: [null] }, /'in' takes/);
      fails({ attr: 'resource.a', lt: null }, /'lt' takes a string, number or \{ref\}/);
      fails({ attr: 'resource.a', gte: true }, /'gte' takes a string, number or \{ref\}/);
      fails({ attr: 'resource.a', like: 1 }, /'like' takes a string or \{ref\}/);
      fails({ attr: 'resource.a', glob: null }, /'glob' takes/);
      fails({ attr: 'resource.a', wildcard: ['a'] }, /'wildcard' takes/);
      fails({ attr: 'resource.a', null: 'yes' }, /must be boolean at \.null/);
      fails({ attr: 'resource.a', eq: { ref: 'principal.id', x: 1 } }, /'eq' takes/);
      fails({ attr: 'resource.a', eq: { ref: '' } }, /'eq' takes/);
      fails({ attr: '', eq: 1 }, /at \.attr/);
    });

    it('checks the attr grammar', () => {
      fails({ attr: 'row.a', eq: 1 }, /"row\.a" must start with principal, actor, resource, env, scope\.<type> at \.attr/);
      fails({ attr: 'resource', eq: 1 }, /"resource" needs a path after resource/);
      fails({ attr: 'resource..a', eq: 1 }, /has an empty segment/);
      fails({ attr: 'resource.a.', eq: 1 }, /has an empty segment/);
      fails({ attr: 'scope.org', eq: 1 }, /must read scope\.<type>\.<path>/);
      fails({ attr: 'scope..a', eq: 1 }, /has an empty segment/);
      fails({ attr: 'scope.a:b.c', eq: 1 }, /names an invalid resource type/);
      for (const s of ['__proto__', 'prototype', 'constructor']) fails({ attr: `principal.${s}.x`, eq: 1 }, new RegExp(`reserved segment "${s}"`));
    });

    it('checks the ref grammar; a value never refers to the resource', () => {
      fails({ attr: 'principal.id', eq: { ref: 'resource.owner' } }, /"resource\.owner" must start with principal, actor, env, scope\.<type> at \.eq\.ref/);
      fails({ attr: 'resource.a', eq: { ref: 'principal' } }, /needs a path after principal/);
      fails({ attr: 'resource.a', eq: { ref: 'scope.org' } }, /must read scope\.<type>\.<path>/);
      fails({ attr: 'resource.a', eq: { ref: 'env.__proto__' } }, /reserved segment/);
    });
  });

  describe('fn nodes', () => {
    it('accepts a registered function with or without args', () => {
      const p = parse({ fn: 'time.between', args: { from: '08:00', to: '18:00', tz: 'Europe/Warsaw' } });
      expect(p).to.deep.include({ kind: 'fn', name: 'time.between' });
      expect(parse({ fn: 'glob' })).to.deep.include({ kind: 'fn', args: {} });
    });

    it('rejects an unknown function', () => {
      fails({ fn: 'time.betwen' }, /unknown condition function "time\.betwen" at \.fn/);
      expect(() => parseCondition({ fn: 'glob' }, { functions: new Set() })).to.throw(AuthzConfigError, /unknown condition function "glob"/);
      fails({ not: { fn: '' } }, /at \.not\.fn/);
    });

    it('takes the function list from anything with has()', () => {
      const registry = new Map([['ip.in', {}]]);
      expect(() => parseCondition({ fn: 'ip.in' }, { functions: registry })).not.to.throw();
    });

    it('rejects args that are not an object', () => {
      fails({ fn: 'glob', args: ['a'] }, /must be object at \.args/);
      fails({ fn: 'glob', args: 'a' }, /must be object at \.args/);
    });

    it('records and checks refs inside args, resource refs included', () => {
      const p = parse({ fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'release/*', more: [{ ref: 'scope.org.prefix' }] } });
      expect(p.facts).to.deep.equal({ roots: ['resource', 'scope'], scopeTypes: ['org'], functions: ['glob'], refs: ['resource.name', 'scope.org.prefix'] });
      fails({ fn: 'glob', args: { value: { ref: 'row.name' } } }, /"row\.name" must start with .* at \.args\.value\.ref/);
    });
  });

  describe('facts', () => {
    it('collect roots, scope types, functions and refs over the tree, sorted and unique', () => {
      const p = parse({
        all: [
          { attr: 'resource.status', eq: 'open' },
          { not: { attr: 'scope.org.policies.open', eq: { ref: 'principal.id' } } },
          {
            any: [
              { attr: 'env.ip', eq: { ref: 'scope.project.ip' } },
              { fn: 'time.between', args: {} },
              { attr: 'resource.status', ne: 'x' },
            ],
          },
        ],
      });
      expect(p.facts).to.deep.equal({
        roots: ['env', 'principal', 'resource', 'scope'],
        scopeTypes: ['org', 'project'],
        functions: ['time.between'],
        refs: ['env.ip', 'principal.id', 'resource.status', 'scope.org.policies.open', 'scope.project.ip'],
      });
      if (p.kind !== 'all') return;
      expect(p.items[0].facts.roots).to.deep.equal(['resource']);
      expect(p.items[1].facts.roots).to.deep.equal(['principal', 'scope']);
    });

    it('are empty for an empty junction', () => {
      expect(parse({ any: [] }).facts).to.deep.equal({ roots: [], scopeTypes: [], functions: [], refs: [] });
    });
  });

  describe('output', () => {
    it('is deeply frozen and detached from the input', () => {
      const input = {
        all: [
          { attr: 'resource.a', in: ['x'] },
          { fn: 'glob', args: { p: { q: [1] } } },
        ],
      };
      const p = parse(input);
      const check = (v: unknown): void => {
        if (v === null || typeof v !== 'object') return;
        expect(Object.isFrozen(v), JSON.stringify(v)).to.equal(true);
        for (const k of Object.keys(v)) check((v as Record<string, unknown>)[k]);
      };
      check(p);
      (input.all[0] as { in: string[] }).in.push('y');
      if (p.kind !== 'all') return;
      expect(p.items[0]).to.deep.include({ operand: { kind: 'literal', value: ['x'] } });
    });

    it('skips undefined properties as JSON does', () => {
      expect(() => parse({ attr: 'resource.a', eq: 1, ne: undefined })).not.to.throw();
      expect(() => parse({ fn: 'glob', args: undefined })).not.to.throw();
    });
  });

  describe('malformed input never crashes or hangs', () => {
    it('rejects cycles', () => {
      const c: Record<string, unknown> = { not: null };
      c.not = c;
      fails(c, /cycle at \.not/);
      const list: unknown[] = [];
      list.push({ any: list });
      fails({ all: list }, /cycle/);
    });

    it('accepts a shared subtree that is not a cycle', () => {
      const leaf = { attr: 'resource.a', eq: 1 };
      expect(() => parse({ all: [leaf, leaf, { not: leaf }] })).not.to.throw();
    });

    it('rejects non-plain objects, functions, symbols, bigints and non-finite numbers', () => {
      fails({ attr: 'resource.a', eq: new Date(0) }, /non-plain object at \.eq/);
      fails({ attr: 'resource.a', eq: new (class X {})() }, /non-plain object/);
      fails({ attr: 'resource.a', eq: () => 1 }, /function is not a JSON value at \.eq/);
      fails({ attr: 'resource.a', eq: Symbol('s') }, /symbol is not a JSON value/);
      fails({ attr: 'resource.a', eq: 1n }, /bigint is not a JSON value/);
      fails({ attr: 'resource.a', eq: NaN }, /NaN is not a finite number/);
      fails({ attr: 'resource.a', in: [1, Infinity] }, /Infinity is not a finite number at \.in\[1\]/);
    });

    it('rejects arrays with holes', () => {
      // eslint-disable-next-line no-sparse-arrays
      fails({ attr: 'resource.a', in: ['a', , 'b'] }, /array has a hole at \.in\[1\]/);
    });

    it('turns a throwing getter or proxy into a config error', () => {
      const getter = Object.defineProperty({ attr: 'resource.a' }, 'eq', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      fails(getter, /reading the condition failed: boom/);
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('trap');
          },
        },
      );
      fails(proxy, /reading the condition failed: trap/);
    });

    it('keeps a "__proto__" key as data', () => {
      const c = JSON.parse('{"attr":"resource.a","__proto__":{"eq":1}}');
      fails(c, /needs one operator|unexpected key "__proto__"/);
    });

    it('caps the depth', () => {
      expect(() => parse(nest(MAX_CONDITION_DEPTH - 1))).not.to.throw();
      fails(nest(MAX_CONDITION_DEPTH), /nested deeper than 32/);
      fails(nest(100000), /nested deeper than 32/);
    });

    it('caps the node count', () => {
      const leaf = { attr: 'resource.a', eq: 1 };
      expect(() => parse({ all: Array.from({ length: MAX_CONDITION_NODES - 1 }, () => leaf) })).not.to.throw();
      fails({ all: Array.from({ length: MAX_CONDITION_NODES }, () => leaf) }, /more than 1000 nodes/);
    });

    it('caps the raw value count before any recursion', () => {
      fails({ attr: 'resource.a', in: Array.from({ length: MAX_CONDITION_VALUES }, (_, i) => i) }, /more than 10000 values/);
      fails({ fn: 'glob', args: { big: Array.from({ length: MAX_CONDITION_VALUES }, () => 'x') } }, /more than 10000 values/);
    });
  });

  describe('properties', () => {
    it('every condition the grammar generator builds parses, and parses the same twice', () => {
      fc.assert(
        fc.property(condition(), (c) => {
          const a = parse(c);
          expect(a).to.deep.equal(parse(c));
        }),
        { numRuns: 500, seed: 3101 },
      );
    });

    it('random JSON never throws anything but AuthzConfigError', () => {
      const junk = fc.letrec<{ v: unknown }>((tie) => ({
        v: fc.oneof({ depthSize: 'small', maxDepth: 5 }, fc.jsonValue({ maxDepth: 2 }), fc.dictionary(fc.constantFrom('all', 'any', 'not', 'attr', 'fn', 'args', 'eq', 'in', 'null', 'ref', 'x', '__proto__'), tie('v'), { maxKeys: 3 }), fc.array(tie('v'), { maxLength: 3 }), fc.constantFrom('resource.a', 'principal.id', 'scope.org.a.b', 'glob', { ref: 'env.x' }, { ref: 'resource.x' })),
      })).v;
      fc.assert(
        fc.property(junk, (c) => {
          try {
            parse(c);
          } catch (e) {
            expect(e).to.be.instanceOf(AuthzConfigError);
          }
        }),
        { numRuns: 2000, seed: 3102 },
      );
    });
  });
});
