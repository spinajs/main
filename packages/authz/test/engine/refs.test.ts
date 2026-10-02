import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { bindEngineRefs, collectRefs, hasEnvRef, readsIdentity, refValues, scopeNodes } from '../../src/engine/refs.js';
import { FALSE, TRUE, and, not, or } from '../../src/contracts/filter.js';
import { GLOBAL } from '../../src/contracts/resource.js';
import type { Principal, ResourceFilter, ResourceRef, Value } from '../../src/index.js';

const expect = chai.expect;

type Truth = boolean | undefined;

const ref = (r: string): { ref: string } => ({ ref: r });
const eq = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value } as ResourceFilter);
const cmpIn = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'in', value } as ResourceFilter);

const ACTOR: Principal = Object.freeze({
  type: 'agent',
  id: 'a1',
  authenticated: true,
  source: 'token',
  attributes: Object.freeze({ pool: 'p1', level: 3, flags: Object.freeze(['x', 'y']), nested: Object.freeze({ deep: true }) }),
});

const ORG: ResourceRef = Object.freeze({ type: 'org', id: 'o1' });
const ORG2: ResourceRef = Object.freeze({ type: 'org', id: 'o2' });
const PROJECT: ResourceRef = Object.freeze({ type: 'project', id: 'p1' });
const DOC: ResourceRef = Object.freeze({ type: 'doc', id: 'd1' });

function hasRefValue(f: unknown, seen = new Set<unknown>()): boolean {
  if (f === null || typeof f !== 'object' || seen.has(f)) return false;
  seen.add(f);
  if (Object.hasOwn(f, 'ref')) return true;
  return Object.values(f as object).some((x) => hasRefValue(x, seen));
}

/** Depth-30 DAG: every level holds its child twice, so a tree walk visits 2^30 nodes. */
function dag(leaf: ResourceFilter, levels = 30): ResourceFilter {
  let f = leaf;
  for (let i = 0; i < levels; i++) {
    const op = i % 2 === 0 ? 'and' : 'or';
    f = Object.freeze({ op, args: Object.freeze([f, Object.freeze({ op: 'not', arg: f }), eq(`f${i}`, i)]) }) as ResourceFilter;
  }
  return f;
}

describe('engine refs: collectRefs', () => {
  it('returns distinct refs in depth-first order', () => {
    const f = and(eq('a', ref('actor.id')), or(eq('b', ref('scope.org.x')), not(eq('c', ref('actor.id')))), eq('d', ref('env.now')));
    expect(collectRefs(f)).to.deep.equal(['actor.id', 'scope.org.x', 'env.now']);
  });

  it('ignores literals, lists, malformed ref objects and non-cmp nodes', () => {
    const f = and(eq('a', 'x'), cmpIn('b', ['x', 1]), eq('c', null), eq('d', { ref: 1 }), eq('e', { ref: 'actor.id', extra: 1 }), { op: 'relation', relation: 'owner' }, { op: 'under', scopes: [ORG] }, { op: 'native:x', args: { ref: 'actor.id' } } as ResourceFilter);
    expect(collectRefs(f)).to.deep.equal([]);
  });

  it('returns a frozen list', () => {
    expect(Object.isFrozen(collectRefs(eq('a', ref('actor.id'))))).to.equal(true);
  });

  it('walks a depth-30 DAG fast', () => {
    const started = Date.now();
    expect(collectRefs(dag(eq('x', ref('actor.id'))))).to.deep.equal(['actor.id']);
    expect(Date.now() - started).to.be.lessThan(5000);
  });
});

describe('engine refs: hasEnvRef', () => {
  it('finds env refs anywhere', () => {
    expect(hasEnvRef(and(eq('a', 1), not(eq('b', ref('env.now')))))).to.equal(true);
    expect(hasEnvRef(eq('a', ref('env')))).to.equal(true);
  });

  it('ignores other roots', () => {
    expect(hasEnvRef(and(eq('a', ref('principal.id')), eq('b', ref('environment.x')), eq('c', ref('scope.env.x'))))).to.equal(false);
    expect(hasEnvRef(TRUE)).to.equal(false);
  });

  it('walks a depth-30 DAG fast', () => {
    const started = Date.now();
    expect(hasEnvRef(dag(eq('x', ref('env.ip'))))).to.equal(true);
    expect(Date.now() - started).to.be.lessThan(5000);
  });
});

describe('engine refs: readsIdentity', () => {
  it('finds actor and principal identity refs anywhere', () => {
    expect(readsIdentity(and(eq('a', 1), not(eq('b', ref('actor.identity.tenant')))))).to.equal(true);
    expect(readsIdentity(eq('a', ref('principal.identity.email')))).to.equal(true);
    expect(readsIdentity(eq('a', ref('principal.identity')))).to.equal(true);
    expect(readsIdentity(eq('a', ref('actor.identity')))).to.equal(true);
  });

  it('ignores other refs', () => {
    expect(readsIdentity(and(eq('a', ref('actor.id')), eq('b', ref('principal.attributes.identity')), eq('c', ref('actor.identityX')), eq('d', ref('scope.org.identity.x')), eq('e', ref('env.identity'))))).to.equal(false);
    expect(readsIdentity(TRUE)).to.equal(false);
  });

  it('walks a depth-30 DAG fast', () => {
    const started = Date.now();
    expect(readsIdentity(dag(eq('x', ref('actor.identity.x'))))).to.equal(true);
    expect(Date.now() - started).to.be.lessThan(5000);
  });
});

describe('engine refs: scopeNodes', () => {
  const ancestors = Object.freeze([DOC, PROJECT, ORG, ORG2, GLOBAL]);

  it('picks the nearest ancestor of each type, self included', () => {
    const nodes = scopeNodes(['scope.org.policies.public', 'scope.org.name', 'scope.doc.title', 'scope.project.x'], { ancestors });
    expect([...nodes.entries()]).to.deep.equal([
      ['org', ORG],
      ['doc', DOC],
      ['project', PROJECT],
    ]);
  });

  it('resolves $global on any request, even on a ref without id', () => {
    expect(scopeNodes(['scope.$global.x'], { ancestors }).get('$global')).to.deep.equal(GLOBAL);
    expect(scopeNodes(['scope.$global.x'], { ancestors: [DOC] }).get('$global')).to.deep.equal(GLOBAL);
    expect(scopeNodes(['scope.$global.x', 'scope.org.x', 'scope.doc.x'], { ancestors: undefined })).to.deep.equal(new Map([['$global', GLOBAL]]));
  });

  it('leaves out a type with no ancestor of that type', () => {
    expect(scopeNodes(['scope.team.x'], { ancestors }).size).to.equal(0);
  });

  it('leaves out a type whose nearest ancestor has no id', () => {
    expect(scopeNodes(['scope.org.x'], { ancestors: [DOC, { type: 'org' }, ORG2, GLOBAL] }).size).to.equal(0);
  });

  it('ignores refs that are not scope refs or have no type', () => {
    expect(scopeNodes(['actor.id', 'env.now', 'scope', 'scope.', 'scopes.org.x', 'principal.scope.org'], { ancestors }).size).to.equal(0);
  });
});

describe('engine refs: refValues', () => {
  const attrs = new Map<string, Readonly<Record<string, unknown>> | null>([
    ['org', Object.freeze({ policies: Object.freeze({ public_links: true, max: 5 }), name: 'acme', tags: Object.freeze(['a', 'b']), at: new Date('2026-01-01T00:00:00.000Z') })],
    ['project', null],
  ]);

  it('reads actor paths', () => {
    const v = refValues(['actor.id', 'actor.type', 'actor.attributes.pool', 'actor.attributes.level', 'actor.attributes.nested.deep', 'actor.authenticated'], ACTOR, attrs);
    expect([...v.entries()]).to.deep.equal([
      ['actor.id', 'a1'],
      ['actor.type', 'agent'],
      ['actor.attributes.pool', 'p1'],
      ['actor.attributes.level', 3],
      ['actor.attributes.nested.deep', true],
      ['actor.authenticated', true],
    ]);
  });

  it('reads scope paths from the attributes of that type', () => {
    const v = refValues(['scope.org.policies.public_links', 'scope.org.policies.max', 'scope.org.name', 'scope.org.at'], ACTOR, attrs);
    expect(Object.fromEntries(v)).to.deep.equal({ 'scope.org.policies.public_links': true, 'scope.org.policies.max': 5, 'scope.org.name': 'acme', 'scope.org.at': '2026-01-01T00:00:00.000Z' });
  });

  it('copies literal lists', () => {
    const v = refValues(['actor.attributes.flags', 'scope.org.tags'], ACTOR, attrs);
    expect(v.get('actor.attributes.flags')).to.deep.equal(['x', 'y']);
    expect(v.get('actor.attributes.flags')).to.not.equal(ACTOR.attributes.flags);
    expect(Object.isFrozen(v.get('actor.attributes.flags'))).to.equal(true);
    expect(v.get('scope.org.tags')).to.deep.equal(['a', 'b']);
  });

  it('leaves out missing values', () => {
    const odd: Principal = {
      ...ACTOR,
      attributes: {
        obj: { a: 1 },
        nul: null,
        und: undefined,
        nan: NaN,
        inf: Infinity,
        bad: new Date('x'),
        mixed: ['a', { b: 1 }],
        bools: [true],
        holes: ['a', , 'b'],
        fn: () => 'x',
        big: BigInt(2),
        sym: Symbol('s'),
      },
    } as unknown as Principal;
    const refs = ['actor.attributes.obj', 'actor.attributes.nul', 'actor.attributes.und', 'actor.attributes.nan', 'actor.attributes.inf', 'actor.attributes.bad', 'actor.attributes.mixed', 'actor.attributes.bools', 'actor.attributes.holes', 'actor.attributes.fn', 'actor.attributes.big', 'actor.attributes.sym', 'actor.attributes.nope', 'actor.attributes.obj.a.b', 'actor', 'actor.attributes', 'actor.id.length', 'actor.toString', 'actor.attributes.hasOwnProperty', 'actor.__proto__', 'actor.constructor.name', 'actor.attributes.prototype', 'scope.project.x', 'scope.team.x', 'scope.org', 'scope.org.policies', 'principal.id', 'env.now', 'resource.id', 'unknown.x', 'scope', ''];
    expect(refValues(refs, odd, attrs).size).to.equal(0);
  });

  it('refuses unsafe segments even when they are own properties', () => {
    const a = JSON.parse('{"__proto__":{"x":"p"},"constructor":{"x":"c"},"prototype":{"x":"t"}}');
    const principal = { ...ACTOR, attributes: a } as Principal;
    expect(refValues(['actor.attributes.__proto__.x', 'actor.attributes.constructor.x', 'actor.attributes.prototype.x'], principal, attrs).size).to.equal(0);
  });

  it('reads each property once and treats a throwing getter as missing', () => {
    let reads = 0;
    const attributes = {};
    Object.defineProperty(attributes, 'g', {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? 'first' : { not: 'literal' };
      },
    });
    Object.defineProperty(attributes, 'boom', {
      enumerable: true,
      get() {
        throw new Error('x');
      },
    });
    const principal = { ...ACTOR, attributes } as Principal;
    const v = refValues(['actor.attributes.g', 'actor.attributes.boom'], principal, attrs);
    expect(reads).to.equal(1);
    expect([...v.entries()]).to.deep.equal([['actor.attributes.g', 'first']]);
  });

  it('treats a throwing proxy as missing', () => {
    const attributes = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
      },
    );
    const principal = { ...ACTOR, attributes } as Principal;
    expect(refValues(['actor.attributes.x'], principal, attrs).size).to.equal(0);
  });

  it('returns a frozen-value map that later changes to the inputs do not affect', () => {
    const list = ['a'];
    const principal = { ...ACTOR, attributes: { list } } as Principal;
    const v = refValues(['actor.attributes.list'], principal, attrs);
    list.push('b');
    expect(v.get('actor.attributes.list')).to.deep.equal(['a']);
  });
});

describe('engine refs: bindEngineRefs', () => {
  const values = new Map<string, Value>([
    ['actor.id', 'a1'],
    ['scope.org.tags', Object.freeze(['a', 'b'])],
  ]);

  it('replaces a known ref with its literal', () => {
    expect(bindEngineRefs(eq('owner', ref('actor.id')), values)).to.deep.equal({ op: 'cmp', field: 'owner', cmp: 'eq', value: 'a1' });
    expect(bindEngineRefs(cmpIn('tag', ref('scope.org.tags')), values)).to.deep.equal({ op: 'cmp', field: 'tag', cmp: 'in', value: ['a', 'b'] });
  });

  it('turns a missing ref into FALSE in positive position', () => {
    expect(bindEngineRefs(eq('x', ref('scope.org.nope')), values)).to.equal(FALSE);
    expect(bindEngineRefs(or(eq('x', ref('nope')), eq('y', 1)), values)).to.deep.equal(eq('y', 1));
  });

  it('turns not(cmp with a missing ref) into FALSE overall', () => {
    expect(bindEngineRefs(not(eq('x', ref('scope.org.nope'))), values)).to.equal(FALSE);
    expect(bindEngineRefs(and(eq('y', 1), not(eq('x', ref('missing')))), values)).to.equal(FALSE);
  });

  it('flips back to FALSE under two nots', () => {
    const f = { op: 'not', arg: { op: 'not', arg: eq('x', ref('missing')) } } as ResourceFilter;
    expect(bindEngineRefs(f, values)).to.equal(FALSE);
    expect(bindEngineRefs(not(or(eq('y', 1), not(eq('x', ref('missing'))))), values)).to.equal(FALSE);
  });

  it('turns a missing ref under one not into TRUE inside the negated part', () => {
    expect(bindEngineRefs(not(and(eq('y', 1), eq('x', ref('missing')))), values)).to.deep.equal(not(eq('y', 1)));
  });

  it('treats malformed values as missing', () => {
    expect(bindEngineRefs(eq('x', { ref: 'actor.id', extra: 1 }), values)).to.equal(FALSE);
    expect(bindEngineRefs(eq('x', { ref: 1 }), values)).to.equal(FALSE);
    expect(bindEngineRefs(eq('x', {}), values)).to.equal(FALSE);
    expect(bindEngineRefs(cmpIn('x', ['a', { ref: 'actor.id' }]), values)).to.equal(FALSE);
    expect(bindEngineRefs(not(cmpIn('x', ['a', true])), values)).to.equal(FALSE);
  });

  it('treats a non-literal value in the map as missing', () => {
    const bad = new Map<string, Value>([['actor.id', { ref: 'actor.id' }]]);
    expect(bindEngineRefs(eq('x', ref('actor.id')), bad)).to.equal(FALSE);
    const obj = new Map<string, unknown>([['actor.id', { a: 1 }]]) as unknown as Map<string, Value>;
    expect(bindEngineRefs(eq('x', ref('actor.id')), obj)).to.equal(FALSE);
  });

  it('leaves literals and other nodes alone', () => {
    const f = and(eq('a', 'x'), cmpIn('b', ['x', 1]), eq('c', null), { op: 'relation', relation: 'owner' }, { op: 'under', scopes: [ORG] }, { op: 'native:geo', args: { r: 1 } } as ResourceFilter);
    expect(bindEngineRefs(f, values)).to.deep.equal(f);
  });

  it('keeps the other cmp properties when binding', () => {
    const f = { op: 'cmp', field: 'path', cmp: 'glob', value: ref('actor.id') } as ResourceFilter;
    expect(bindEngineRefs(f, values)).to.deep.equal({ op: 'cmp', field: 'path', cmp: 'glob', value: 'a1' });
  });

  it('simplifies the result and returns frozen nodes', () => {
    const out = bindEngineRefs(and(eq('a', ref('actor.id')), or(eq('b', ref('missing')), TRUE)), values);
    expect(out).to.deep.equal(eq('a', 'a1'));
    expect(Object.isFrozen(out)).to.equal(true);
  });

  it('never mutates the input', () => {
    const inner = { op: 'cmp', field: 'a', cmp: 'eq', value: ref('actor.id') };
    const f = { op: 'and', args: [inner, { op: 'not', arg: inner }] } as ResourceFilter;
    const before = JSON.stringify(f);
    bindEngineRefs(f, values);
    expect(JSON.stringify(f)).to.equal(before);
  });

  it('replaces a node with an unknown op by polarity, even when it holds no ref', () => {
    const mystery = { op: 'mystery', value: ref('actor.id') } as unknown as ResourceFilter;
    expect(bindEngineRefs(mystery, values)).to.equal(FALSE);
    expect(bindEngineRefs(not(mystery), values)).to.equal(FALSE);
    expect(bindEngineRefs(not(and(eq('y', 1), mystery)), values)).to.deep.equal(not(eq('y', 1)));
    expect(bindEngineRefs({ op: 'native:' } as ResourceFilter, values)).to.equal(FALSE);
    expect(bindEngineRefs({ op: 42 } as unknown as ResourceFilter, values)).to.equal(FALSE);
  });

  it('binds a ref to an empty list: in [] is FALSE, nin [] is TRUE (the one place binding yields TRUE)', () => {
    const empty = new Map<string, Value>([['scope.org.tags', Object.freeze([])]]);
    expect(bindEngineRefs(cmpIn('tag', ref('scope.org.tags')), empty)).to.equal(FALSE);
    expect(bindEngineRefs({ op: 'cmp', field: 'tag', cmp: 'nin', value: ref('scope.org.tags') } as ResourceFilter, empty)).to.equal(TRUE);
  });

  it('throws on a node that is not an object', () => {
    expect(() => bindEngineRefs({ op: 'and', args: [null] } as unknown as ResourceFilter, values)).to.throw();
    expect(() => bindEngineRefs({ op: 'not' } as unknown as ResourceFilter, values)).to.throw();
  });

  it('binds a depth-30 DAG fast, with both polarities of one shared node', () => {
    const started = Date.now();
    const out = bindEngineRefs(dag(eq('x', ref('missing'))), values);
    expect(Date.now() - started).to.be.lessThan(10000);
    expect(collectRefs(out)).to.deep.equal([]);
  });
});

// ---- properties ----

const FIELDS = ['f0', 'f1', 'f2', 'f3'];
const REFS = ['actor.id', 'actor.attributes.pool', 'scope.org.x', 'scope.$global.y', 'env.now', 'principal.id', 'resource.id'];

const arbLeaf: fc.Arbitrary<ResourceFilter> = fc.oneof(
  fc.constant(TRUE),
  fc.constant(FALSE),
  fc.record({ field: fc.constantFrom(...FIELDS), lit: fc.constantFrom('v', 1, true) }).map(({ field, lit }) => eq(field, lit)),
  fc.record({ field: fc.constantFrom(...FIELDS), r: fc.constantFrom(...REFS) }).map(({ field, r }) => eq(field, ref(r))),
  fc.record({ field: fc.constantFrom(...FIELDS), r: fc.constantFrom(...REFS) }).map(({ field, r }) => cmpIn(field, ['a', ref(r)])),
  fc.constantFrom(...REFS).map((r) => ({ op: 'mystery', value: ref(r) } as unknown as ResourceFilter)),
);

const arbFilter: fc.Arbitrary<ResourceFilter> = fc.letrec<{ node: ResourceFilter }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    arbLeaf,
    fc.record({ op: fc.constantFrom('and' as const, 'or' as const), args: fc.array(tie('node'), { maxLength: 4 }) }),
    tie('node').map((arg) => ({ op: 'not' as const, arg })),
  ),
})).node;

const arbValues: fc.Arbitrary<Map<string, Value>> = fc.subarray(REFS).chain((known) => fc.tuple(...known.map(() => fc.constantFrom<Value>('w', 2, false, Object.freeze(['a', 1])))).map((vals) => new Map(known.map((k, i) => [k, vals[i]]))));

/** Row: each field holds T/F/U; a cmp reads its field's value; a cmp still holding a ref is `forced`. */
function kleene(f: ResourceFilter, row: Readonly<Record<string, Truth>>, forced: Truth): Truth {
  switch (f.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and': {
      const xs = f.args.map((x) => kleene(x, row, forced));
      return xs.includes(false) ? false : xs.includes(undefined) ? undefined : true;
    }
    case 'or': {
      const xs = f.args.map((x) => kleene(x, row, forced));
      return xs.includes(true) ? true : xs.includes(undefined) ? undefined : false;
    }
    case 'not': {
      const x = kleene(f.arg, row, forced);
      return x === undefined ? undefined : !x;
    }
    case 'cmp':
      return hasRefValue(f.value) ? forced : row[f.field];
    default:
      return undefined;
  }
}

const arbRow = fc.record(Object.fromEntries(FIELDS.map((k) => [k, fc.constantFrom<Truth>(true, false, undefined)])) as Record<string, fc.Arbitrary<Truth>>);

describe('engine refs: properties', () => {
  it('leaves no ref after binding, whatever is known', () => {
    fc.assert(
      fc.property(arbFilter, arbValues, (f, values) => {
        const out = bindEngineRefs(f, values);
        return collectRefs(out).length === 0 && !hasRefValue(out);
      }),
      { numRuns: 300 },
    );
  });

  it('only narrows: with every ref missing, bound TRUE implies TRUE with those comparisons UNKNOWN', () => {
    fc.assert(
      fc.property(arbFilter, arbRow, (f, row) => {
        const bound = kleene(bindEngineRefs(f, new Map()), row, undefined);
        return bound !== true || kleene(f, row, undefined) === true;
      }),
      { numRuns: 500 },
    );
  });

  it('binds known refs to the literal it was given', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FIELDS), fc.constantFrom(...REFS), fc.constantFrom<Value>('w', 2, false, ['a', 1]), (field, r, value) => {
        const out = bindEngineRefs(eq(field, ref(r)), new Map([[r, value]]));
        return out.op === 'cmp' && JSON.stringify(out.value) === JSON.stringify(value);
      }),
      { numRuns: 200 },
    );
  });
});
