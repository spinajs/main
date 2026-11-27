import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, Rewrite } from '@spinajs/authz-ir';

import { releaseSolver, verifyAssertion } from '../src/index.js';
import type { Assertion, SatSolver, Verdict } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';
import { PRINCIPAL, neverBroken, randomPolicy, search } from './oracle.js';
import type { Tuple } from './oracle.js';

const source = { origin: 'config:authz' };
const tuples = (allowed: string[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const viewer: Rewrite = { computed: 'viewer' };

/** `doc:read` is `read`, `doc:comment` is `commenter`; `roles` maps a role to `<type>#<relation>` keys. */
function policy(roles: Record<string, string[]>, read: Rewrite = viewer): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      folder: { relations: { viewer: tuples(['user']) }, permissions: {} },
      doc: { relations: { parent: tuples(['folder']), viewer: tuples(['user']), commenter: tuples(['user']), blocked: tuples(['user']) }, permissions: { read, comment: { computed: 'commenter' } } },
    },
    permissions: { 'doc:read': { type: 'doc', relation: 'read', list: false, source }, 'doc:comment': { type: 'doc', relation: 'comment', list: false, source } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: Object.fromEntries(Object.entries(roles).map(([r, keys]) => [r, keys.map((key) => ({ type: key.split('#')[0], relation: key.split('#')[1] }))])) },
    opaque: [],
  };
}

/** `auditor` sorts first, so the relations both roles hold are labelled `auditor`'s. */
const shared = { auditor: ['doc#viewer'], reader: ['doc#viewer'] };
const never = (holder: string, permission = 'doc:read'): Assertion => ({ kind: 'never', holder, permission });
/** Every permission under an intersection with a term that holds for everyone: the same semantics, answered by the bounded engine. */
const twinOf = (ir: PolicyIR): PolicyIR => ({
  ...ir,
  types: Object.fromEntries(Object.entries(ir.types).map(([t, def]) => [t, { ...def, permissions: Object.fromEntries(Object.entries(def.permissions).map(([p, r]) => [p, { intersection: [r, { intersection: [] }] }])) }])),
});
const roleSelectors = (ir: PolicyIR): string[] => Object.entries(ir.principal.roles).flatMap(([role, keys]) => [`role:${role}`, ...new Set(keys.map((key) => `role:${role}@${key.type}`))]);
/** A counterexample in the oracle's notation, its principal renamed to the oracle's. */
const oracleTuples = (v: Verdict): Tuple[] => {
  const principal = v.counterexample?.principal.id;
  return (v.counterexample?.tuples ?? []).map(({ object, relation, subject: s }) => {
    const subject = s.type === 'user' && s.id !== '*' ? (s.id === principal ? PRINCIPAL : `user:other-${s.id}`) : `${s.type}:${s.id}${s.relation === undefined ? '' : `#${s.relation}`}`;
    return { object: `${object.type}:${object.id}`, relation, subject };
  });
};
const tupleNames = (v: Verdict): string[] => (v.counterexample?.tuples ?? []).map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`);

describe('never(role) of a role that shares a relation with another role', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const verdictOf = (ir: PolicyIR, a: Assertion, k: number): Promise<Verdict> => verifyAssertion(ir, a, { k, solver: () => Promise.resolve(z3) });

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the second-role tests are skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  for (const k of [2, 3]) {
    describe(`k = ${k}`, () => {
      it('counts a named member of the shared relation for the second role', async () => {
        const cases: Array<[Record<string, string[]>, Rewrite, string]> = [
          [shared, viewer, 'doc:d1#viewer@user:u1'],
          [{ auditor: ['doc#viewer'], reader: ['doc#commenter', 'doc#viewer'] }, viewer, 'doc:d1#viewer@user:u1'],
          [{ auditor: ['folder#viewer'], reader: ['folder#viewer'] }, { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } }, 'folder:f1#viewer@user:u1'],
        ];
        for (const [roles, read, member] of cases) {
          for (const holder of ['role:reader', `role:reader@${member.split(':')[0]}`, 'role:auditor']) {
            const v = await verdictOf(policy(roles, read), never(holder), k);
            expect([v.result, v.engine], `${JSON.stringify(roles)} ${holder}`).to.deep.equal(['violated', 'exact']);
            expect(tupleNames(v), holder).to.include(member);
          }
        }
      });

      it('holds where the second role sits on relations that do not carry the permission', async () => {
        for (const reader of [['doc#commenter'], ['folder#viewer']]) {
          const ir = policy({ auditor: ['doc#viewer'], reader });
          expect(await verdictOf(ir, never('role:reader'), k), reader.join()).to.include({ result: 'holds', engine: 'exact' });
          expect(await verdictOf(ir, never('role:auditor', 'doc:comment'), k), reader.join()).to.include({ result: 'holds', engine: 'exact' });
        }
      });

      it('counts the shared relation under a deny the data decides, and holds where the deny takes the permission from every member', async () => {
        const v = await verdictOf(policy(shared, { exclusion: { base: viewer, subtract: { computed: 'blocked' } } }), never('role:reader'), k);
        expect(v).to.include({ result: 'violated', engine: 'bounded', bound: k });
        expect(tupleNames(v)).to.include('doc:d1#viewer@user:u1');
        expect(tupleNames(v).some((n) => n.includes('#blocked@'))).to.eq(false);
        expect(await verdictOf(policy(shared, { exclusion: { base: viewer, subtract: viewer } }), never('role:reader'), k)).to.include({ result: 'holds', engine: 'bounded', bound: k });
      });

      it('counts a relation whose type has another relation under the same first role', async () => {
        // `auditor` sorts first and holds both relations, so both are labelled `role:auditor@doc`.
        const roles = { auditor: ['doc#viewer', 'doc#commenter'], reader: ['doc#commenter'] };
        const either: Rewrite = { union: [viewer, { computed: 'commenter' }] };
        for (const holder of ['role:reader', 'role:reader@doc', 'doc#commenter']) {
          const v = await verdictOf(policy(roles, either), never(holder), k);
          expect([v.result, v.engine], holder).to.deep.equal(['violated', 'exact']);
          expect(tupleNames(v), holder).to.include('doc:d1#commenter@user:u1');
        }
        for (const holder of ['role:reader', 'doc#commenter']) {
          const v = await verdictOf(policy(roles, { exclusion: { base: either, subtract: { computed: 'blocked' } } }), never(holder), k);
          expect(v, holder).to.include({ result: 'violated', engine: 'bounded', bound: k });
          expect(tupleNames(v), holder).to.include('doc:d1#commenter@user:u1');
        }
      });
    });
  }

  it('answers holds for no role the brute-force oracle refutes, on seeded random policies, in both engines', async () => {
    let compared = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const ir = randomPolicy(seed);
      for (const [permission, { type, relation }] of Object.entries(ir.permissions)) {
        for (const [selector, found] of search(ir, type, relation, roleSelectors(ir), 3)) {
          for (const subject of [ir, twinOf(ir)]) {
            const v = await verdictOf(subject, never(selector, permission), 2);
            const label = `seed ${seed} never(${selector}, ${permission}) ${v.engine}`;
            if (v.result === 'holds') expect(found.narrow, label).to.eq(undefined);
            if (v.result === 'violated' && v.engine === 'exact') expect(neverBroken(ir, oracleTuples(v), `${v.counterexample?.resource.type}:${v.counterexample?.resource.id}`, relation, selector), label).to.not.eq(undefined);
            compared++;
          }
        }
      }
    }
    expect(compared).to.be.greaterThan(300);
  });
});
