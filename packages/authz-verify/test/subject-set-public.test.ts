import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, Rewrite, SubjectTypeRef } from '@spinajs/authz-ir';

import { accessOf, permissionMatrix, releaseSolver, verifyAssertion } from '../src/index.js';
import type { Assertion, SatSolver, Verdict } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';

const source = { origin: 'config:authz' };
const tuples = (allowed: SubjectTypeRef[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const parentOf = (via: string): RelationDef => ({ allowed: [via], source: { kind: 'ancestor', via } });
const bind = (type: string, relation: string) => ({ type, relation, list: false, source });

interface Shape {
  /** What `tenant#member` allows. */
  readonly member?: SubjectTypeRef[];
  /** The `member` relation of each set type. */
  readonly sets?: Record<string, SubjectTypeRef[]>;
  readonly enter?: Rewrite;
  /** The set types lie under a tenant, not under `$global`. */
  readonly underTenant?: boolean;
  /** Each set type gets a permission `<type>:see` that its members hold, so its relation is a holder of its own. */
  readonly see?: boolean;
  /** `<type>#<relation>` keys of a second role `other`; `member` sorts first, so a relation both hold is labelled `member`'s. */
  readonly other?: string[];
}

/** `tenant#member` allows `group#member`, and the group allows everyone, unless the shape says otherwise. */
function policy(shape: Shape = {}): PolicyIR {
  const sets = shape.sets ?? { group: ['user:*'] };
  const setType = (allowed: SubjectTypeRef[]) => ({ relations: { parent: parentOf(shape.underTenant === true ? 'tenant' : '$global'), member: tuples(allowed) }, permissions: shape.see === true ? { see: { computed: 'member' } } : {} });
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      $global: { relations: {}, permissions: {} },
      tenant: {
        relations: { parent: parentOf('$global'), member: tuples(shape.member ?? ['group#member']), guest: tuples(['group#member']), admin: tuples(['user']), banned: tuples(['user']) },
        permissions: { enter: shape.enter ?? { computed: 'member' }, manage: { computed: 'admin' }, closed: { intersection: [] } },
      },
      ...Object.fromEntries(Object.entries(sets).map(([type, allowed]) => [type, setType(allowed)])),
    },
    permissions: { 'tenant:enter': bind('tenant', 'enter'), 'tenant:manage': bind('tenant', 'manage'), ...(shape.see === true ? Object.fromEntries(Object.keys(sets).map((t) => [`${t}:see`, bind(t, 'see')])) : {}) },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: { member: [{ type: 'tenant', relation: 'member' }], ...(shape.other === undefined ? {} : { other: shape.other.map((key) => ({ type: key.split('#')[0], relation: key.split('#')[1] })) }) } },
    opaque: [],
  };
}

const banned: Rewrite = { exclusion: { base: { computed: 'member' }, subtract: { computed: 'banned' } } };
/** The same reach under an intersection with a term that holds for everyone: not monotone, so the bounded engine answers. */
const twin: Rewrite = { intersection: [{ computed: 'member' }, { intersection: [] }] };

const depth2 = { group: ['team#member'], team: ['user:*'] };
const depth3 = { group: ['team#member'], team: ['org#member'], org: ['user:*'] };
const cycle = { group: ['team#member'], team: ['group#member', 'user:*'] };
const cycle3 = { group: ['team#member'], team: ['org#member'], org: ['group#member', 'user:*'] };
const namedCycle3 = { group: ['team#member'], team: ['org#member'], org: ['group#member', 'user'] };
const cycle4 = { group: ['team#member'], team: ['org#member'], org: ['club#member'], club: ['group#member', 'user:*'] };
const shapes: Record<string, Shape> = {
  public: {},
  named: { sets: { group: ['user'] } },
  both: { member: ['user', 'group#member'] },
  depth2: { sets: depth2 },
  depth3: { sets: depth3 },
  cycle: { sets: cycle },
  cycle3: { sets: cycle3 },
  namedCycle3: { sets: namedCycle3 },
  cycle4: { sets: cycle4 },
  twoRoles: { other: ['tenant#member'] },
  twoRolesNamed: { member: ['user', 'group#member'], sets: { group: ['user'] }, other: ['tenant#member'] },
  twoRolesCycle: { sets: cycle, other: ['tenant#member', 'team#member'] },
};

const tupleNames = (v: Verdict): string[] => (v.counterexample?.tuples ?? []).map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}${t.subject.relation === undefined ? '' : `#${t.subject.relation}`}`);
/** The counterexample enters through a subject set on `tenant#member` and a wildcard behind it. */
const throughSet = (v: Verdict): boolean => tupleNames(v).some((n) => /^tenant:t\d#member@group:g\d#member$/.test(n)) && tupleNames(v).some((n) => /^\w+:\w\d#member@user:\*$/.test(n));

const never = (holder: string, permission = 'tenant:enter'): Assertion => ({ kind: 'never', holder, permission });
const onlyVia = (...holders: string[]): Assertion => ({ kind: 'onlyVia', permission: 'tenant:enter', holders });
const isolated = (...except: string[]): Assertion => ({ kind: 'isolated', type: 'tenant', except });

describe('a public member behind a subject set', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const verdictOf = (ir: PolicyIR, a: Assertion, k: number): Promise<Verdict> => verifyAssertion(ir, a, { k, solver: () => Promise.resolve(z3) });

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the subject-set tests are skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  for (const k of [2, 3]) {
    describe(`k = ${k}`, () => {
      it('is not excused by an exception of isolated that names the outer relation', async () => {
        for (const except of ['tenant#member', 'role:member']) {
          const v = await verdictOf(policy(), isolated(except), k);
          expect(v.result, except).to.eq('violated');
          expect(throughSet(v), except).to.eq(true);
        }
      });

      it('is not covered by onlyVia of the outer relation', async () => {
        for (const holder of ['tenant#member', 'role:member']) {
          const v = await verdictOf(policy({ enter: banned }), onlyVia(holder), k);
          expect(v, holder).to.include({ result: 'violated', engine: 'bounded' });
          expect(throughSet(v), holder).to.eq(true);
        }
      });

      it('counts for the bounded never() of the outer relation, its role and its public spelling', async () => {
        for (const holder of ['tenant#member', 'role:member', 'public:tenant#member', 'public:group#member']) {
          const v = await verdictOf(policy({ enter: banned }), never(holder), k);
          expect(v, holder).to.include({ result: 'violated', engine: 'bounded' });
          expect(throughSet(v), holder).to.eq(true);
        }
      });

      it('counts a named member behind the set for the bounded never() of the outer relation', async () => {
        const v = await verdictOf(policy({ sets: { group: ['user'] }, enter: banned }), never('tenant#member'), k);
        expect(v).to.include({ result: 'violated', engine: 'bounded' });
        expect(tupleNames(v).some((n) => /^tenant:t\d#member@group:g\d#member$/.test(n))).to.eq(true);
        expect(tupleNames(v).some((n) => /^group:g\d#member@user:u1$/.test(n))).to.eq(true);
      });

      it('counts for the exact never() of the inner relation, named or public, beside a shorter direct path', async () => {
        for (const [members, holder] of [[['user'], 'group#member'], [['user:*'], 'group#member'], [['user:*'], 'public:group#member']] as const) {
          for (const member of [['group#member'], ['user', 'group#member']]) {
            const v = await verdictOf(policy({ member, sets: { group: [...members] } }), never(holder), k);
            expect([v.result, v.engine], `${holder} ${members.join()} ${member.join()}`).to.deep.equal(['violated', 'exact']);
            expect(tupleNames(v)).to.include('tenant:t1#member@group:g1#member');
          }
        }
      });

      it('is found at depth 2 and 3 and through a cycle of subject sets', async () => {
        for (const [name, sets] of Object.entries({ depth2, depth3, cycle })) {
          expect((await verdictOf(policy({ sets }), isolated('tenant#member'), k)).result, `${name} isolated`).to.eq('violated');
          expect((await verdictOf(policy({ sets, enter: banned }), onlyVia('tenant#member'), k)).result, `${name} onlyVia`).to.eq('violated');
          expect((await verdictOf(policy({ sets, enter: banned }), never('tenant#member'), k)).result, `${name} never`).to.eq('violated');
          for (const inner of Object.keys(sets)) expect(await verdictOf(policy({ sets }), never(`${inner}#member`), k), `${name} never ${inner}`).to.include({ result: 'violated', engine: 'exact' });
        }
      });

      it('leaves a set that holds no public member excused, also through a cycle', async () => {
        const namedSets: Array<Record<string, SubjectTypeRef[]>> = [{ group: ['user'] }, { group: ['team#member'], team: ['group#member', 'user'] }];
        for (const sets of namedSets) {
          const ir = policy({ sets, underTenant: true });
          expect((await verdictOf(ir, isolated(), k)).result).to.eq('violated');
          for (const except of ['tenant#member', 'role:member']) expect(await verdictOf(ir, isolated(except), k), except).to.include({ result: 'holds', bound: k });
          expect(await verdictOf(policy({ sets, enter: banned }), onlyVia('tenant#member'), k)).to.include({ result: 'holds', bound: k });
        }
      });

      it('is accepted where a public selector is listed, and only there', async () => {
        // `public:group#member` is the bounded engine's spelling of the same grant, on the relation that holds the wildcard.
        for (const except of [['public'], ['tenant#member', 'public:tenant#member'], ['public:group#member']]) expect(await verdictOf(policy(), isolated(...except), k), except.join()).to.include({ result: 'holds', bound: k });
        for (const holders of [['tenant#member', 'public'], ['role:member', 'public:tenant#member']]) expect(await verdictOf(policy({ enter: banned }), onlyVia(...holders), k), holders.join()).to.include({ result: 'holds', bound: k });
        for (const except of [['tenant#guest'], ['public:tenant#guest'], ['tenant#member', 'public:tenant#guest']]) expect((await verdictOf(policy(), isolated(...except), k)).result, except.join()).to.eq('violated');
      });

      it('does not count on a relation that does not carry the permission, nor where a deny takes it from everyone', async () => {
        expect(await verdictOf(policy(), never('tenant#guest'), k)).to.include({ result: 'holds', engine: 'exact' });
        expect(await verdictOf(policy(), never('group#member', 'tenant:manage'), k)).to.include({ result: 'holds', engine: 'exact' });
        const closed = policy({ enter: { exclusion: { base: { computed: 'member' }, subtract: { computed: 'closed' } } } });
        for (const a of [never('tenant#member'), never('group#member'), isolated('tenant#member'), onlyVia('tenant#member')]) expect(await verdictOf(closed, a, k), JSON.stringify(a)).to.include({ result: 'holds', engine: 'bounded', bound: k });
      });

      it('counts every relation of a cycle of sets for never() in both engines', async () => {
        for (const [name, sets] of Object.entries({ cycle, cycle3, namedCycle3, cycle4 })) {
          for (const type of Object.keys(sets)) {
            const label = `${name} never(${type}#member)`;
            expect(await verdictOf(policy({ sets }), never(`${type}#member`), k), label).to.include({ result: 'violated', engine: 'exact' });
            expect(await verdictOf(policy({ sets, enter: twin }), never(`${type}#member`), k), label).to.include({ result: 'violated', engine: 'bounded' });
          }
        }
      });

      it('gets the same verdict from the exact and the bounded engine', async () => {
        let pairs = 0;
        for (const [name, shape] of Object.entries(shapes)) {
          const inner = Object.keys(shape.sets ?? { group: [] }).flatMap((t) => [never(`${t}#member`), never(`public:${t}#member`)]);
          const other = shape.other === undefined ? [] : ['role:other', ...shape.other.map((key) => `role:other@${key.split('#')[0]}`)].map((h) => never(h));
          for (const a of [never('tenant#member'), never('role:member'), never('public:tenant#member'), never('tenant#guest'), ...inner, ...other, onlyVia('tenant#member'), onlyVia('tenant#member', 'public:tenant#member')]) {
            const label = `${name} ${JSON.stringify(a)}`;
            const exact = await verdictOf(policy(shape), a, k);
            const search = await verdictOf(policy({ ...shape, enter: twin }), a, k);
            expect(search.result, label).to.eq(exact.result);
            if (exact.result === 'violated') expect([exact.engine, search.engine], label).to.deep.equal(['exact', 'bounded']);
            pairs++;
          }
        }
        expect(pairs).to.eq(127);
      });
    });
  }

  it('keeps a path through the set apart from a shorter one to the same state', async () => {
    // `team#member` is reached first from `tenant#member` directly; the path through `group#member` comes later.
    const ir = policy({ member: ['group#member', 'team#member'], sets: { group: ['team#member'], team: ['user'] } });
    expect(await verdictOf(ir, never('group#member'), 2)).to.include({ result: 'violated', engine: 'exact' });
  });

  it('the matrix and never() agree on members behind a subject set', async () => {
    const matrixSets: Array<Record<string, SubjectTypeRef[]>> = [{ group: ['user:*'] }, { group: ['user'] }, depth2, cycle];
    for (const sets of matrixSets) {
      const ir = policy({ sets, see: true });
      const m = permissionMatrix(ir);
      for (const holder of [...Object.keys(m.cells), 'tenant#member', 'group#member', 'public:group#member', 'tenant#guest', 'public']) {
        for (const permission of m.permissions) {
          const v = await verdictOf(ir, never(holder, permission), 2);
          const access = accessOf(m, holder, permission);
          const label = `${JSON.stringify(sets)} ${holder} ${permission}`;
          expect([label, v.result === 'holds'], 'never holds exactly where the matrix says never').to.deep.equal([label, access === 'never']);
          expect([label, v.result === 'violated'], 'never is violated exactly where the matrix says always').to.deep.equal([label, access === 'always']);
        }
      }
    }
    expect(accessOf(permissionMatrix(policy({ see: true })), 'group#member', 'tenant:enter')).to.eq('always');
  });

  it('leaves implies and separated as they were', async () => {
    for (const shape of [{}, { sets: cycle }]) {
      expect(await verdictOf(policy(shape), { kind: 'implies', a: 'tenant:enter', b: 'tenant:manage' }, 2)).to.include({ result: 'violated', engine: 'exact' });
      expect(await verdictOf(policy(shape), { kind: 'separated', a: 'tenant:enter', b: 'tenant:manage', on: 'same-resource' }, 2)).to.include({ result: 'violated', engine: 'exact' });
    }
  });
});
