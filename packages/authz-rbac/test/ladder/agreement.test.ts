import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { GrantDef, LadderDef, RoleDef } from '../../src/index.js';

// Randomized B06 check for ladders, implied roles, tags and provenance (first written as a review probe).

const expect = chai.expect;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const r = (type: string, id: string): ResourceRef => ({ type, id });
const [O1, O2, P1, P2, P3] = [r('org', 'o1'), r('org', 'o2'), r('project', 'p1'), r('project', 'p2'), r('project', 'p3')];
const [f1, f2, f3, f4] = [r('file', 'f1'), r('file', 'f2'), r('file', 'f3'), r('file', 'f4')];
const ROWS: Record<string, ResourceRef[]> = { org: [O1, O2], project: [P1, P2, P3], file: [f1, f2, f3, f4] };
const alice = userPrincipal('alice');
const PW = ['project', 'org'];
const TYPES = ['org', 'project', 'file'];
const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const PERMS = ['file:read', 'inspect:view', 'repo:read', 'mr:approve', 'release:cut', 'lib:publish', 'report:read', 'beta:view'];
const PERMISSIONS: PermissionInput[] = PERMS.map((name) => ({ name, types: TYPES }));
const LADDERS: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }];
const ROLES: RoleDef[] = [
  role('viewer', ['file:read', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'repo:read', grantedAt: PW }], { ladder: 'project' }),
  role(
    'editor',
    [
      { permission: 'mr:approve', grantedAt: PW },
      { permission: 'release:cut', requiresTag: 'beta', grantedAt: PW },
    ],
    { ladder: 'project' },
  ),
  role('maintainer', [{ permission: 'lib:publish', grantedAt: PW }], { ladder: 'project' }),
  role('org.admin', [], { implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect'] }] }),
  // An implied 'descendants' contribution that carries a tag: its scope itself must stay out of the tag rows.
  role('team.lead', [{ permission: 'beta:view', requiresTag: 'beta' }], { implies: [{ role: 'editor', at: 'descendants', tags: ['beta'] }] }),
  role('auditor', [{ permission: 'report:read', grantedAt: ['project'] }]),
];
const scopes = new FakeScopeResolver({ types: TYPES, nodes: [{ ref: O1 }, { ref: O2 }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: P3, parent: O2 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }, { ref: f3, parent: P3 }, { ref: f4, parent: P1 }] });
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

function registry() {
  const reg = new PermissionRegistryImpl();
  reg.register(PERMISSIONS, 'test');
  reg.freeze();
  return reg;
}

async function model(rows: readonly Assignment[]) {
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  return m;
}

let seed = 12345;
const rnd = (n: number) => {
  // Math.imul keeps the product exact; the low bits of this generator repeat with a short period.
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return (seed >>> 16) % n;
};
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
const SCOPES = [GLOBAL, O1, O2, P1, P2, P3, f1, f2, f3, f4];
const TAGSETS = [[], [], ['inspect'], ['beta'], ['inspect', 'beta']];

describe('authz-rbac ladders: check ⇔ filter over random worlds (B06)', () => {
  it('the type-level filter selects exactly the rows a check allows, and assignment order changes no vote', async function () {
    this.timeout(120_000);
    const mismatches = new Set<string>();
    for (let w = 0; w < 150; w++) {
      const rows: Assignment[] = [];
      for (let i = 0, n = 1 + rnd(4); i < n; i++) {
        const tags = pick(TAGSETS);
        rows.push({ id: `a${i}`, subject: { type: 'user', id: 'alice' }, role: pick(ROLES).name, scope: pick(SCOPES), source: 'test', ...(tags.length ? { tags } : {}) });
      }
      const m = await model(rows);
      const reversed = await model([...rows].reverse());
      const world = JSON.stringify(rows.map((a) => [a.role, a.scope.id ?? a.scope.type, a.tags]));
      for (const permission of PERMS) {
        for (const type of TYPES) {
          const filter = (await m.evaluate({ principal: alice, permission, resource: { type } }, ctx())).permitWhen;
          for (const ref of ROWS[type]) {
            const listed = (await evaluateFilter(filter, { id: ref.id }, { principal: alice, ref, context: ctx() })) === true;
            const vote = await m.evaluate({ principal: alice, permission, resource: ref }, ctx());
            if (listed !== (vote.permitWhen.op === 'true')) mismatches.add(`${world} ${permission} ${ref.id}: listed=${listed} filter=${JSON.stringify(filter)}`);
            const other = await reversed.evaluate({ principal: alice, permission, resource: ref }, ctx());
            if (JSON.stringify([vote.reason, vote.permitWhen]) !== JSON.stringify([other.reason, other.permitWhen])) mismatches.add(`order ${world} ${permission} ${ref.id}`);
          }
        }
      }
    }
    expect([...mismatches].slice(0, 5)).to.deep.equal([]);
  });
});
