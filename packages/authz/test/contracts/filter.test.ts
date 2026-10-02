import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import * as root from '../../src/index.js';
import { FALSE, TRUE, and, bindRefs, not, or, simplify } from '../../src/contracts/filter.js';
import type { FilterOp, Principal, ResourceFilter, Value } from '../../src/index.js';

const expect = chai.expect;

type CmpOp = Extract<ResourceFilter, { op: 'cmp' }>['cmp'];

const cmp = (field: string, value: Value = true, op: CmpOp = 'eq'): ResourceFilter => ({ op: 'cmp', field, cmp: op, value });
const a = cmp('a');
const b = cmp('b');
const c = cmp('c');
const rawAnd = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'and', args });
const rawOr = (...args: ResourceFilter[]): ResourceFilter => ({ op: 'or', args });
const rawNot = (arg: ResourceFilter): ResourceFilter => ({ op: 'not', arg });

const deepFreeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

// Kleene three-valued logic: 0 = F, 1 = U, 2 = T.
type K = 0 | 1 | 2;
const kleene = (f: ResourceFilter, leaf: (f: ResourceFilter) => K): K => {
  switch (f.op) {
    case 'true':
      return 2;
    case 'false':
      return 0;
    case 'and':
      return f.args.reduce<K>((acc, x) => Math.min(acc, kleene(x, leaf)) as K, 2);
    case 'or':
      return f.args.reduce<K>((acc, x) => Math.max(acc, kleene(x, leaf)) as K, 0);
    case 'not':
      return (2 - kleene(f.arg, leaf)) as K;
    default:
      return leaf(f);
  }
};

const FIELDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const ASSIGNMENTS: Record<string, K>[] = [];
for (let n = 0; n < 3 ** FIELDS.length; n++) {
  const row: Record<string, K> = {};
  FIELDS.forEach((field, i) => (row[field] = (Math.floor(n / 3 ** i) % 3) as K));
  ASSIGNMENTS.push(row);
}
const atomLeaf =
  (row: Record<string, K>) =>
  (f: ResourceFilter): K => {
    if (f.op === 'cmp' && f.field in row) return row[f.field];
    throw new Error(`unexpected leaf ${JSON.stringify(f)}`);
  };
const truthTable = (f: ResourceFilter) => ASSIGNMENTS.map((row) => kleene(f, atomLeaf(row)));

const atomArb: fc.Arbitrary<ResourceFilter> = fc.constantFrom(...FIELDS).map((field) => ({ op: 'cmp', field, cmp: 'eq', value: true }));
const treeOf = (leaf: fc.Arbitrary<ResourceFilter>) =>
  fc.letrec<{ node: ResourceFilter }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', maxDepth: 5 },
      leaf,
      fc.constantFrom<ResourceFilter>(TRUE, FALSE, { op: 'true' }, { op: 'false' }),
      fc.tuple(fc.constantFrom<'and' | 'or'>('and', 'or'), fc.array(tie('node'), { maxLength: 4 })).map(([op, args]): ResourceFilter => ({ op, args })),
      tie('node').map(rawNot),
    ),
  })).node;
const treeArb = treeOf(atomArb);

const walk = (f: ResourceFilter, visit: (f: ResourceFilter) => void): void => {
  visit(f);
  if (f.op === 'and' || f.op === 'or') f.args.forEach((x) => walk(x, visit));
  if (f.op === 'not') walk(f.arg, visit);
};

const AUTHENTICATED_AT = new Date('2026-01-02T03:04:05.000Z');
const NOW = new Date('2026-10-02T12:00:00.000Z');
const principal: Principal = {
  type: 'user',
  id: '42',
  authenticated: true,
  source: 'session',
  attributes: {
    pool: 'p1',
    groups: ['g1', 'g2'],
    ids: [1, 2],
    mixedKinds: ['a', 1],
    nul: null,
    flag: false,
    zero: 0,
    obj: { x: 1 },
    nan: NaN,
    inf: Infinity,
    big: BigInt(10),
    fn: () => 1,
    withNull: ['a', null],
    withObject: [1, {}],
    withNaN: [1, NaN],
    // eslint-disable-next-line no-sparse-arrays
    sparse: [1, , 2],
    badDate: new Date('not a date'),
    undef: undefined,
    nested: { deep: 'yes' },
    hostile: JSON.parse('{"__proto__": "evil", "constructor": "c", "prototype": "p"}'),
  },
  authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: ['totp'], authenticatedAt: AUTHENTICATED_AT },
};
const env = { now: NOW, region: 'eu', limit: 5 };
const scope = { principal, env };
const ref = (r: string) => ({ ref: r });

const MISSING_REFS = ['principal.attributes.nope', 'principal.attributes.obj', 'principal.attributes.nan', 'principal.attributes.inf', 'principal.attributes.big', 'principal.attributes.fn', 'principal.attributes.withNull', 'principal.attributes.withObject', 'principal.attributes.withNaN', 'principal.attributes.sparse', 'principal.attributes.badDate', 'principal.attributes.undef', 'principal.attributes.nested', 'principal.authn', 'principal', 'env', 'env.nope', 'principal.__proto__', 'principal.constructor', 'principal.toString', 'principal.attributes.hostile.__proto__', 'principal.attributes.hostile.constructor', 'principal.attributes.hostile.prototype', 'principal.attributes.constructor.name', 'principal.id.length'];

describe('filter contracts', () => {
  it('is exported from the package root', () => {
    expect(root.TRUE).to.eq(TRUE);
    expect(root.FALSE).to.eq(FALSE);
    expect(root.and).to.eq(and);
    expect(root.or).to.eq(or);
    expect(root.not).to.eq(not);
    expect(root.simplify).to.eq(simplify);
    expect(root.bindRefs).to.eq(bindRefs);
  });

  it('types follow the design', () => {
    const ops: FilterOp[] = ['true', 'false', 'and', 'or', 'not', 'cmp', 'relation', 'under', 'native:rbac'];
    // @ts-expect-error native ops carry the 'native:' prefix
    const bad: FilterOp = 'nativerbac';
    const values: Value[] = ['x', 1, true, null, ['a', 1], { ref: 'principal.id' }];
    // @ts-expect-error array values hold strings and numbers only
    const badValue: Value = [true];
    const filters: ResourceFilter[] = [{ op: 'cmp', field: 'path', cmp: 'wildcard', value: 'a/*' }, { op: 'cmp', field: 'path', cmp: 'glob', value: 'a/**' }, { op: 'cmp', field: 'deleted_at', cmp: 'null' }, { op: 'relation', relation: 'owner' }, { op: 'under', scopes: [{ type: 'org', id: '1' }] }, { op: 'native:rbac', args: { rule: 1 } }, { op: 'native:rbac' }];
    // @ts-expect-error unknown comparison
    const badCmp: ResourceFilter = { op: 'cmp', field: 'x', cmp: 'regex', value: 'a' };
    // @ts-expect-error and needs args
    const badAnd: ResourceFilter = { op: 'and' };

    expect([ops, bad, values, badValue, filters, badCmp, badAnd]).to.have.length(7);
  });

  describe('TRUE and FALSE', () => {
    it('are frozen singletons', () => {
      expect(TRUE).to.deep.eq({ op: 'true' });
      expect(FALSE).to.deep.eq({ op: 'false' });
      expect(Object.isFrozen(TRUE)).to.eq(true);
      expect(Object.isFrozen(FALSE)).to.eq(true);
    });

    it('simplify returns the singletons for constant results', () => {
      expect(simplify({ op: 'true' })).to.eq(TRUE);
      expect(simplify({ op: 'false' })).to.eq(FALSE);
      expect(simplify(rawAnd(a, rawNot(TRUE)))).to.eq(FALSE);
      expect(simplify(rawOr(rawNot({ op: 'false' }), a))).to.eq(TRUE);
    });
  });

  describe('simplify', () => {
    it('folds constants', () => {
      expect(simplify(rawAnd(a, FALSE, b))).to.eq(FALSE);
      expect(simplify(rawAnd(TRUE, a, TRUE, b))).to.deep.eq(rawAnd(a, b));
      expect(simplify(rawOr(a, TRUE, b))).to.eq(TRUE);
      expect(simplify(rawOr(FALSE, a, FALSE, b))).to.deep.eq(rawOr(a, b));
      expect(simplify(rawNot(TRUE))).to.eq(FALSE);
      expect(simplify(rawNot(FALSE))).to.eq(TRUE);
    });

    it('turns empty and singleton and/or into their identity or their argument', () => {
      expect(simplify(rawAnd())).to.eq(TRUE);
      expect(simplify(rawOr())).to.eq(FALSE);
      expect(simplify(rawAnd(a))).to.eq(a);
      expect(simplify(rawOr(a))).to.eq(a);
      expect(simplify(rawAnd(TRUE, TRUE))).to.eq(TRUE);
      expect(simplify(rawOr(FALSE))).to.eq(FALSE);
    });

    it('flattens nested and in and, or in or, but not across', () => {
      expect(simplify(rawAnd(a, rawAnd(b, rawAnd(c))))).to.deep.eq(rawAnd(a, b, c));
      expect(simplify(rawOr(rawOr(a, b), c))).to.deep.eq(rawOr(a, b, c));
      expect(simplify(rawAnd(a, rawOr(b, c)))).to.deep.eq(rawAnd(a, rawOr(b, c)));
    });

    it('removes double negation', () => {
      expect(simplify(rawNot(rawNot(a)))).to.eq(a);
      expect(simplify(rawNot(rawNot(rawNot(a))))).to.deep.eq(rawNot(a));
      expect(simplify(rawNot(rawNot(rawAnd(a, TRUE))))).to.eq(a);
    });

    it('dedupes structurally equal args, keeping the first occurrence and the order', () => {
      expect(simplify(rawOr(b, a, cmp('b'), c, cmp('a')))).to.deep.eq(rawOr(b, a, c));
      expect(simplify(rawAnd(a, a))).to.eq(a);
      expect(simplify(rawAnd(rawOr(a, b), rawOr(a, b), c))).to.deep.eq(rawAnd(rawOr(a, b), c));
      expect(simplify(rawAnd(rawOr(a, b), rawOr(b, a)))).to.deep.eq(rawAnd(rawOr(a, b), rawOr(b, a)));
    });

    it('dedupes across differently ordered object keys and with ref values', () => {
      const x: ResourceFilter = { op: 'cmp', field: 'a', cmp: 'eq', value: 1 };
      const y = { value: 1, cmp: 'eq', field: 'a', op: 'cmp' } as ResourceFilter;
      expect(simplify(rawAnd(x, y))).to.eq(x);

      const r1: ResourceFilter = { op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } };
      const r2 = { value: { ref: 'principal.id' }, field: 'owner', op: 'cmp', cmp: 'eq' } as ResourceFilter;
      const r3: ResourceFilter = { op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'actor.id' } };
      expect(simplify(rawOr(r1, r2, r3))).to.deep.eq(rawOr(r1, r3));

      const n1: ResourceFilter = { op: 'native:rbac', args: { b: [1, { y: 2, x: 1 }], a: 'k' } };
      const n2: ResourceFilter = { op: 'native:rbac', args: { a: 'k', b: [1, { x: 1, y: 2 }] } };
      expect(simplify(rawAnd(n1, n2))).to.eq(n1);
      const isNull: ResourceFilter = { op: 'cmp', field: 'a', cmp: 'null' };
      expect(simplify(rawAnd(isNull, { op: 'cmp', field: 'a', cmp: 'null', value: undefined }))).to.eq(isNull);
    });

    it('never dedupes native nodes with unserialisable args by structure, and never throws', () => {
      const cyclic: Record<string, unknown> = { k: 1 };
      cyclic.self = cyclic;
      const nodes: ResourceFilter[] = [
        { op: 'native:x', args: cyclic },
        { op: 'native:x', args: cyclic },
        { op: 'native:x', args: { n: BigInt(1) } },
        { op: 'native:x', args: { n: BigInt(1) } },
        { op: 'native:x', args: { fn: () => 1 } },
        { op: 'native:x', args: { fn: () => 1 } },
        { op: 'native:x', args: { d: new Date(0) } },
        { op: 'native:x', args: { d: new Date(0) } },
      ];

      expect(() => simplify(rawAnd(...nodes))).to.not.throw();
      expect(simplify(rawAnd(...nodes))).to.deep.eq(rawAnd(...nodes));
      expect(simplify(rawOr(nodes[0], nodes[0], nodes[2], nodes[2]))).to.deep.eq(rawOr(nodes[0], nodes[2]));
    });

    it('folds trivial leaves', () => {
      expect(simplify(cmp('a', [], 'in'))).to.eq(FALSE);
      expect(simplify(cmp('a', [], 'nin'))).to.eq(TRUE);
      expect(simplify({ op: 'under', scopes: [] })).to.eq(FALSE);
      expect(simplify(rawAnd(b, cmp('a', [], 'in')))).to.eq(FALSE);
      expect(simplify(rawNot(cmp('a', [], 'nin')))).to.eq(FALSE);

      const keep: ResourceFilter[] = [cmp('a', ['x'], 'in'), cmp('a', ref('principal.attributes.groups'), 'in'), cmp('a', ['x'], 'nin'), { op: 'under', scopes: [{ type: 'org', id: '1' }] }, { op: 'relation', relation: 'owner' }, { op: 'native:x', args: [] }];
      for (const leaf of keep) expect(simplify(leaf)).to.eq(leaf);
    });

    it('does not apply rewrites that break three-valued logic or SQL equivalence', () => {
      expect(simplify(rawAnd(a, rawNot(a)))).to.deep.eq(rawAnd(a, rawNot(a)));
      expect(simplify(rawOr(a, rawNot(a)))).to.deep.eq(rawOr(a, rawNot(a)));
      expect(simplify(rawNot(cmp('a', 1, 'eq')))).to.deep.eq(rawNot(cmp('a', 1, 'eq')));
      expect(simplify(rawAnd(a, rawOr(a, b)))).to.deep.eq(rawAnd(a, rawOr(a, b)));
      expect(simplify(rawOr(a, rawAnd(a, b)))).to.deep.eq(rawOr(a, rawAnd(a, b)));
      expect(simplify(rawNot(rawAnd(a, b)))).to.deep.eq(rawNot(rawAnd(a, b)));
      expect(simplify(rawNot(rawOr(a, b)))).to.deep.eq(rawNot(rawOr(a, b)));
      expect(simplify(rawAnd(c, a, b))).to.deep.eq(rawAnd(c, a, b));
    });

    it('recurses into every and/or/not argument', () => {
      expect(simplify(rawNot(rawAnd(TRUE, a)))).to.deep.eq(rawNot(a));
      expect(simplify(rawOr(rawAnd(a, FALSE), b))).to.eq(b);
      expect(simplify(rawAnd(rawOr(rawNot(rawNot(a)), a), rawNot(rawOr(b))))).to.deep.eq(rawAnd(a, rawNot(b)));
    });

    it('does not mutate its input', () => {
      const input = deepFreeze(rawAnd(TRUE, rawOr(a, a, rawAnd(b, c)), rawNot(rawNot(c)), cmp('x', [], 'in')));
      const before = JSON.stringify(input);
      expect(() => simplify(input)).to.not.throw();
      expect(JSON.stringify(input)).to.eq(before);
    });

    it('is idempotent on fixed cases', () => {
      const cases = [rawAnd(a, rawAnd(b, rawOr(c, c)), rawNot(rawNot(rawOr(a)))), rawOr(rawNot(rawAnd()), a), rawNot(rawOr(rawAnd(a, b), rawAnd(b, a), FALSE)), rawAnd(a, rawNot(a), rawOr(a, rawNot(rawNot(a))))];
      for (const f of cases) expect(simplify(simplify(f))).to.deep.eq(simplify(f));
    });

    it('is idempotent (property)', () => {
      fc.assert(
        fc.property(treeArb, (f) => {
          expect(simplify(simplify(f))).to.deep.eq(simplify(f));
        }),
      );
    });

    it('preserves the Kleene truth table over 6 boolean atoms (property)', () => {
      fc.assert(
        fc.property(treeArb, (f) => {
          expect(truthTable(simplify(f))).to.deep.eq(truthTable(f));
        }),
      );
    });
  });

  describe('constructors', () => {
    it('simplify the built node', () => {
      expect(and()).to.eq(TRUE);
      expect(or()).to.eq(FALSE);
      expect(and(a)).to.eq(a);
      expect(or(a)).to.eq(a);
      expect(and(TRUE, a)).to.eq(a);
      expect(or(TRUE, a)).to.eq(TRUE);
      expect(or(FALSE, a)).to.eq(a);
      expect(and(FALSE, a)).to.eq(FALSE);
      expect(and(a, and(b, c))).to.deep.eq(rawAnd(a, b, c));
      expect(and(a, rawAnd(b, rawAnd(c, a)))).to.deep.eq(rawAnd(a, b, c));
      expect(or(a, or(b, c), a)).to.deep.eq(rawOr(a, b, c));
      expect(not(not(a))).to.eq(a);
      expect(not(TRUE)).to.eq(FALSE);
      expect(not(FALSE)).to.eq(TRUE);
      expect(not(a)).to.deep.eq(rawNot(a));
    });

    it('agree with the raw tree (property)', () => {
      fc.assert(
        fc.property(fc.array(treeArb, { maxLength: 4 }), (xs) => {
          expect(truthTable(and(...xs))).to.deep.eq(truthTable(rawAnd(...xs)));
          expect(truthTable(or(...xs))).to.deep.eq(truthTable(rawOr(...xs)));
          if (xs.length > 0) expect(truthTable(not(xs[0]))).to.deep.eq(truthTable(rawNot(xs[0])));
        }),
      );
    });
  });

  describe('bindRefs', () => {
    it('binds principal paths', () => {
      expect(bindRefs(cmp('owner', ref('principal.id')), scope)).to.deep.eq(cmp('owner', '42'));
      expect(bindRefs(cmp('kind', ref('principal.type')), scope)).to.deep.eq(cmp('kind', 'user'));
      expect(bindRefs(cmp('pool', ref('principal.attributes.pool')), scope)).to.deep.eq(cmp('pool', 'p1'));
      expect(bindRefs(cmp('m', ref('principal.authn.method')), scope)).to.deep.eq(cmp('m', 'password'));
      expect(bindRefs(cmp('g', ref('principal.attributes.groups'), 'in'), scope)).to.deep.eq(cmp('g', ['g1', 'g2'], 'in'));
      expect(bindRefs(cmp('g', ref('principal.attributes.ids'), 'in'), scope)).to.deep.eq(cmp('g', [1, 2], 'in'));
      expect(bindRefs(cmp('g', ref('principal.attributes.mixedKinds'), 'in'), scope)).to.deep.eq(cmp('g', ['a', 1], 'in'));
      expect(bindRefs(cmp('mfa', ref('principal.authn.mfa'), 'in'), scope)).to.deep.eq(cmp('mfa', ['totp'], 'in'));
      expect(bindRefs(cmp('f', ref('principal.attributes.flag')), scope)).to.deep.eq(cmp('f', false));
      expect(bindRefs(cmp('z', ref('principal.attributes.zero')), scope)).to.deep.eq(cmp('z', 0));
      expect(bindRefs(cmp('t', ref('principal.authn.authenticatedAt'), 'lt'), scope)).to.deep.eq(cmp('t', '2026-01-02T03:04:05.000Z', 'lt'));
    });

    it('binds env paths and Dates as ISO strings', () => {
      expect(bindRefs(cmp('region', ref('env.region')), scope)).to.deep.eq(cmp('region', 'eu'));
      expect(bindRefs(cmp('n', ref('env.limit'), 'lte'), scope)).to.deep.eq(cmp('n', 5, 'lte'));
      expect(bindRefs(cmp('expires', ref('env.now'), 'gt'), scope)).to.deep.eq(cmp('expires', '2026-10-02T12:00:00.000Z', 'gt'));
    });

    it('binds null as null', () => {
      expect(bindRefs(cmp('n', ref('principal.attributes.nul')), scope)).to.deep.eq(cmp('n', null));
    });

    it('fails closed on a missing ref: FALSE under an even number of nots, TRUE under an odd number', () => {
      const missing = cmp('m', ref('principal.attributes.nope'));
      expect(bindRefs(missing, scope)).to.eq(FALSE);
      expect(bindRefs(rawNot(missing), scope)).to.eq(FALSE);
      expect(bindRefs(rawNot(rawNot(missing)), scope)).to.eq(FALSE);
      expect(bindRefs(rawAnd(a, missing), scope)).to.eq(FALSE);
      expect(bindRefs(rawOr(a, missing), scope)).to.eq(a);
      expect(bindRefs(rawNot(rawAnd(a, missing)), scope)).to.deep.eq(rawNot(a));
      expect(bindRefs(rawNot(rawOr(a, missing)), scope)).to.eq(FALSE);
      expect(bindRefs(rawAnd(b, rawNot(rawAnd(a, missing))), scope)).to.deep.eq(rawAnd(b, rawNot(a)));
    });

    it('counts non-Value results and unsafe paths as missing', () => {
      for (const r of MISSING_REFS) {
        expect(bindRefs(cmp('m', ref(r)), scope), r).to.eq(FALSE);
        expect(bindRefs(rawNot(cmp('m', ref(r))), scope), r).to.eq(FALSE);
      }
    });

    it('leaves refs with other roots intact', () => {
      for (const r of ['actor.type', 'actor.id', 'scope.org.policies.public_links', 'resource.owner', 'unknown', 'principalx.id', 'envy.now']) {
        const f = cmp('x', ref(r));
        expect(bindRefs(f, scope), r).to.deep.eq(f);
      }
      expect(bindRefs(rawAnd(cmp('x', ref('actor.type')), cmp('o', ref('principal.id'))), scope)).to.deep.eq(rawAnd(cmp('x', ref('actor.type')), cmp('o', '42')));
    });

    it('leaves non-ref values and other leaves alone, and simplifies the result', () => {
      const leaves: ResourceFilter[] = [cmp('a', 'principal.id'), cmp('a', ['x'], 'in'), { op: 'relation', relation: 'owner' }, { op: 'under', scopes: [{ type: 'org', id: '1' }] }, { op: 'native:x', args: { ref: 'principal.id' } }];
      for (const leaf of leaves) expect(bindRefs(leaf, scope)).to.deep.eq(leaf);
      expect(bindRefs(rawAnd(TRUE, rawNot(rawNot(cmp('o', ref('principal.id')))), cmp('o', ref('principal.id'))), scope)).to.deep.eq(cmp('o', '42'));
    });

    it('does not mutate its input', () => {
      const input = deepFreeze(rawAnd(cmp('o', ref('principal.id')), rawNot(cmp('m', ref('principal.attributes.nope'))), cmp('g', ref('principal.attributes.groups'), 'in'), cmp('x', ref('actor.id'))));
      const before = JSON.stringify(input);
      expect(() => bindRefs(input, scope)).to.not.throw();
      expect(JSON.stringify(input)).to.eq(before);
      expect(principal.attributes.groups).to.deep.eq(['g1', 'g2']);
    });

    const RESOLVABLE_REFS = ['principal.id', 'principal.type', 'principal.attributes.pool', 'principal.attributes.groups', 'principal.attributes.nul', 'principal.authn.method', 'env.now', 'env.region', 'env.limit'];
    const OTHER_REFS = ['actor.type', 'scope.org.policies.public_links'];
    const refLeaf: fc.Arbitrary<ResourceFilter> = fc.tuple(fc.constantFrom(...RESOLVABLE_REFS, ...MISSING_REFS, ...OTHER_REFS), fc.constantFrom<CmpOp>('eq', 'ne', 'in', 'lt')).map(([r, op]) => cmp('x', ref(r), op));

    it('leaves no principal or env ref behind (property)', () => {
      fc.assert(
        fc.property(treeOf(fc.oneof(atomArb, refLeaf)), (f) => {
          walk(bindRefs(f, scope), (n) => {
            if (n.op === 'cmp' && n.value !== null && typeof n.value === 'object' && 'ref' in n.value) {
              expect(n.value.ref).to.not.match(/^(principal|env)(\.|$)/);
            }
          });
        }),
      );
    });

    it('fails closed for one missing ref anywhere in the tree (property)', () => {
      const MARK = 'missing';
      const missingLeaf = fc.tuple(fc.constantFrom(...MISSING_REFS), fc.constantFrom<CmpOp>('eq', 'ne', 'in', 'nin', 'lt')).map(([r, op]) => cmp(MARK, ref(r), op));
      const place = (f: ResourceFilter, m: ResourceFilter, k: number): ResourceFilter => {
        let leaves = 0;
        walk(f, (n) => n.op !== 'and' && n.op !== 'or' && n.op !== 'not' && leaves++);
        if (leaves === 0) return rawAnd(f, m);
        // By position: constants and atoms may be shared instances.
        const target = k % leaves;
        let seen = 0;
        const swap = (n: ResourceFilter): ResourceFilter => {
          if (n.op === 'and' || n.op === 'or') return { op: n.op, args: n.args.map(swap) };
          if (n.op === 'not') return rawNot(swap(n.arg));
          return seen++ === target ? m : n;
        };
        return swap(f);
      };

      fc.assert(
        fc.property(treeArb, missingLeaf, fc.nat(), (t, m, k) => {
          const f = place(t, m, k);
          let marks = 0;
          walk(f, (n) => n.op === 'cmp' && n.field === MARK && marks++);
          expect(marks).to.eq(1);

          const bound = bindRefs(f, scope);
          for (const row of ASSIGNMENTS) {
            const read =
              (v: K) =>
              (n: ResourceFilter): K =>
                n.op === 'cmp' && n.field === MARK ? v : atomLeaf(row)(n);
            const floor = Math.min(kleene(f, read(2)), kleene(f, read(0)));
            expect(kleene(bound, atomLeaf(row))).to.be.at.most(floor);
          }
        }),
      );
    });
  });
});
