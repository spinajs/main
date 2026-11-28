import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, Rewrite } from '@spinajs/authz-ir';

import { accessOf, holderKey, permissionMatrix, verifyAssertion } from '../src/index.js';
import type { Access, Assertion, Verdict } from '../src/index.js';
import { randomPolicy } from './oracle.js';

const noSolver = { k: 2, solver: async () => undefined };
const source = { origin: 'config:authz' };
const tuples = (allowed: string[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const viewer: Rewrite = { computed: 'viewer' };
const never = (holder: string, permission = 'doc:read'): Assertion => ({ kind: 'never', holder, permission });

/** `roles` maps a role to `<type>#<relation>` keys. */
function policy(roles: Record<string, string[]>, read: Rewrite = viewer): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      doc: { relations: { viewer: tuples(['user']), commenter: tuples(['user']) }, permissions: { read } },
    },
    permissions: { 'doc:read': { type: 'doc', relation: 'read', list: false, source } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: Object.fromEntries(Object.entries(roles).map(([r, keys]) => [r, keys.map((key) => ({ type: key.split('#')[0], relation: key.split('#')[1] }))])) },
    opaque: [],
  };
}

const HIDDEN: Rewrite[] = [{ opaque: 'model:legacy' }, { computed: 'undefined_relation' }];

/** Each permission of a seeded policy gains a part the analysis cannot see: beside it, under it, or instead of it. */
function withHiddenParts(seed: number): PolicyIR {
  const ir = randomPolicy(seed);
  let i = seed;
  for (const def of Object.values(ir.types)) {
    for (const [name, r] of Object.entries(def.permissions)) {
      const hidden = HIDDEN[i % HIDDEN.length];
      const shapes: Rewrite[] = [{ union: [r, hidden] }, { intersection: [r, hidden] }, hidden];
      def.permissions[name] = shapes[i % shapes.length];
      i++;
    }
  }
  return ir;
}

/** The first role holds every relation of the type it holds first, beside the roles that share them. */
function withDenseRole(seed: number): PolicyIR {
  const ir = randomPolicy(seed);
  const [first] = Object.keys(ir.principal.roles).sort();
  const keys = ir.principal.roles[first];
  const type = keys[0].type;
  const more = Object.keys(ir.types[type].relations).filter((r) => r !== 'up' && !keys.some((k) => k.relation === r));
  ir.principal.roles[first] = [...keys, ...more.map((relation) => ({ type, relation }))];
  return ir;
}

/** Every selector `never()` takes for the policy: the rows, every role and role on a type, every relation, and the public forms. */
function selectors(ir: PolicyIR): string[] {
  const relations = Object.entries(ir.types).flatMap(([t, def]) => Object.keys(def.relations).map((r) => `${t}#${r}`));
  const roles = Object.entries(ir.principal.roles).flatMap(([role, keys]) => [`role:${role}`, ...keys.map((k) => `role:${role}@${k.type}`)]);
  return [...new Set([...permissionMatrix(ir).holders.map(holderKey), ...roles, ...relations, ...relations.map((r) => `public:${r}`), 'public'])];
}

describe('accessOf and never() on the same policy', function () {
  this.timeout(120_000);

  it('does not answer never for a permission that reaches an opaque term or an undefined name', async () => {
    for (const read of [{ opaque: 'model:legacy' }, { computed: 'undefined_relation' }, { union: [{ computed: 'commenter' }, { opaque: 'model:legacy' }] }]) {
      const ir = policy({}, read);
      const m = permissionMatrix(ir);
      for (const holder of ['doc#viewer', 'public']) {
        const v = await verifyAssertion(ir, never(holder), noSolver);
        expect([JSON.stringify(read), holder, v.result], 'never() is not decided').to.deep.equal([JSON.stringify(read), holder, 'unknown']);
        expect([JSON.stringify(read), holder, accessOf(m, holder, 'doc:read')]).to.deep.equal([JSON.stringify(read), holder, 'conditional']);
      }
    }
  });

  it('reads ir.opaque as never() does: it does not make accessOf conditional', async () => {
    const ir: PolicyIR = { ...policy({ auditor: ['doc#viewer'] }), opaque: [{ kind: 'model', name: 'legacy' }] };
    const m = permissionMatrix(ir);
    expect(m.everyone).to.deep.equal({});
    expect(await verifyAssertion(ir, never('doc#commenter'), noSolver)).to.include({ result: 'holds', engine: 'exact' });
    expect(accessOf(m, 'doc#commenter', 'doc:read')).to.equal('never');
  });

  it('keeps always where a holder reaches the permission beside an opaque term', async () => {
    const ir = policy({}, { union: [viewer, { opaque: 'model:legacy' }] });
    expect(await verifyAssertion(ir, never('doc#viewer'), noSolver)).to.include({ result: 'violated', engine: 'exact' });
    expect(accessOf(permissionMatrix(ir), 'doc#viewer', 'doc:read')).to.equal('always');
  });

  it('answers never for no selector where never() is unknown through a hidden part, on seeded policies', async () => {
    let unknown = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const ir = withHiddenParts(seed);
      const m = permissionMatrix(ir);
      for (const holder of selectors(ir)) {
        for (const permission of m.permissions) {
          const v = await verifyAssertion(ir, never(holder, permission), noSolver);
          if (v.result !== 'unknown' || !v.opaque.some((o) => o.kind === 'rewrite')) continue;
          unknown++;
          expect(`seed ${seed} ${holder} ${permission}: ${accessOf(m, holder, permission)}`).to.not.match(/: never$/);
        }
      }
    }
    expect(unknown).to.be.greaterThan(1000);
  });

  it('answers always for a second role and for a relation beside another one of the same role', async () => {
    const either: Rewrite = { union: [viewer, { computed: 'commenter' }] };
    const cases: Array<[string, PolicyIR, string]> = [
      ['second role', policy({ auditor: ['doc#viewer'], reader: ['doc#viewer'] }), 'role:reader'],
      ['second role on a type', policy({ auditor: ['doc#viewer'], reader: ['doc#viewer'] }), 'role:reader@doc'],
      ['collapsed relation', policy({ auditor: ['doc#viewer', 'doc#commenter'], reader: ['doc#commenter'] }, either), 'doc#commenter'],
      ['one role on two relations', policy({ auditor: ['doc#viewer', 'doc#commenter'] }, either), 'doc#commenter'],
    ];
    for (const [name, ir, holder] of cases) {
      expect(await verifyAssertion(ir, never(holder), noSolver), name).to.include({ result: 'violated', engine: 'exact' });
      expect(accessOf(permissionMatrix(ir), holder, 'doc:read'), name).to.equal('always');
    }
  });

  it('gives every role a row, and each relation of a role that holds two of one type a row of its own', () => {
    const roles = { auditor: ['doc#viewer', 'doc#commenter'], reader: ['doc#commenter'] };
    const m = permissionMatrix(policy(roles, { computed: 'commenter' }));
    expect(m.holders.map(holderKey)).to.deep.equal(['doc#commenter', 'doc#viewer', 'role:auditor@doc', 'role:reader@doc']);
    expect(m.cells).to.deep.equal({
      'doc#commenter': { 'doc:read': 'always' },
      'doc#viewer': { 'doc:read': 'never' },
      'role:auditor@doc': { 'doc:read': 'always' },
      'role:reader@doc': { 'doc:read': 'always' },
    });
    // The auditor's row is labelled `doc#viewer`, and it reads commenter too.
    expect(accessOf(m, 'doc#viewer', 'doc:read')).to.equal('never');
  });

  it('agrees with never() on every selector and permission of seeded policies', async () => {
    const tally = { holds: 0, violated: 0, unknown: 0 };
    for (let seed = 1; seed <= 16; seed++) {
      for (const ir of [randomPolicy(seed), withDenseRole(seed), withHiddenParts(seed)]) {
        const m = permissionMatrix(ir);
        for (const holder of selectors(ir)) {
          for (const permission of m.permissions) {
            const v = await verifyAssertion(ir, never(holder, permission), noSolver);
            tally[v.result]++;
            const expected: Record<Verdict['result'], Access> = { holds: 'never', violated: 'always', unknown: 'conditional' };
            expect(`seed ${seed} never(${holder}, ${permission}) ${v.result}: ${accessOf(m, holder, permission)}`).to.equal(`seed ${seed} never(${holder}, ${permission}) ${v.result}: ${expected[v.result]}`);
          }
        }
      }
    }
    expect(tally.holds).to.be.greaterThan(2000);
    expect(tally.violated).to.be.greaterThan(500);
    expect(tally.unknown).to.be.greaterThan(1500);
  });
});
