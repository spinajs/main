import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { FakeRelationResolver, FakeScopeResolver, evaluateFilter, fakeEvaluationContext, userPrincipal, withCeiling, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, compileGrants, compileRoles, createRbacExtensions, readRbacInput, runRbacPipeline, scopeMatcher } from '../../src/index.js';
import type { AssignmentStore, RbacExtension, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');
const bot = { type: 'service', id: 'bot' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const FILES = ['f1', 'f2', 'f3', 'f4'].map((id): ResourceRef => ({ type: 'file', id }));
// o1 → p1 → f1, f2; o1 → p2 → f3; o1 → f4
const NODES = [
  { ref: P1, parent: O1 },
  { ref: P2, parent: O1 },
  { ref: FILES[0], parent: P1 },
  { ref: FILES[1], parent: P1 },
  { ref: FILES[2], parent: P2 },
  { ref: FILES[3], parent: O1 },
];

const assignment = (id: string, role: string, scope: ResourceRef, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role, scope, source: 'test', ...extra });

describe('authz-rbac scopeMatcher', () => {
  const onPath = scopeMatcher('file', [FILES[0], P1, O1]);

  it('GLOBAL and every node of the path, by key', () => {
    for (const scope of [GLOBAL, FILES[0], P1, O1, { type: 'project', id: 'p1' }]) expect(onPath(scope), JSON.stringify(scope)).to.equal(true);
  });

  it('a node off the path does not match, nor one of another type with the same id', () => {
    for (const scope of [P2, FILES[1], { type: 'org', id: 'p1' }, { type: 'file', id: 'p1' }]) expect(onPath(scope), JSON.stringify(scope)).to.equal(false);
  });

  it("a type-only scope reaches the rows of its own type only, never an ancestor's type", () => {
    expect(onPath({ type: 'file' })).to.equal(true);
    expect(onPath({ type: 'project' })).to.equal(false);
    expect(onPath({ type: 'org' })).to.equal(false);
  });

  it('an empty path (a type-level request) still matches GLOBAL and its own type-only scope', () => {
    const typeLevel = scopeMatcher('file', []);
    expect([GLOBAL, { type: 'file' }, FILES[0], { type: 'project' }].map(typeLevel)).to.deep.equal([true, true, false, false]);
  });
});

describe('authz-rbac check ⇔ type-level under residual (B06 property)', () => {
  const ROLES: RoleDef[] = [
    { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read' }] },
    { name: 'editor', extends: ['viewer'], assignable: true, source: 'test', grants: [{ permission: 'file:write' }] },
    { name: 'limited', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read', on: [{ type: 'file', id: 'f1' }] }] },
    { name: 'writer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:write' }] },
    { name: 'owner', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read', relation: 'owner' }] },
    { name: 'orgOnly', extends: [], assignable: true, scopeTypes: ['org'], source: 'test', grants: [{ permission: 'file:read' }] },
    { name: 'fixed', extends: [], assignable: false, source: 'test', grants: [{ permission: 'file:read' }] },
  ];
  const ROLE_NAMES = ROLES.map((r) => r.name);
  const OWNERS: Record<string, string> = { f1: 'alice', f2: 'bob', f3: 'alice', f4: 'carol' };
  const row = (f: ResourceRef) => ({ id: f.id, owner: OWNERS[f.id!] });
  const owner = new FakeRelationResolver('file', 'owner', (p, _ref, subject) => (subject as { owner?: string } | undefined)?.owner === p.id);
  const relational = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ nodes: NODES })], relations: [owner] });
  const registry = new PermissionRegistryImpl();
  registry.register(
    [
      { name: 'file:read', types: ['file', 'project', 'org'] },
      { name: 'file:write', types: ['file', 'project', 'org'] },
    ],
    'test',
  );
  registry.freeze();
  const graph = compileRoles(ROLES);
  const grants = compileGrants(graph, registry);
  const SCOPES: ResourceRef[] = [GLOBAL, O1, P1, P2, ...FILES, { type: 'project' }, { type: 'file' }];

  async function vote(principal: Principal, store: AssignmentStore, resource: ResourceRef, extensions: readonly RbacExtension[]) {
    return runRbacPipeline(await readRbacInput({ principal, permission: 'file:read', resource }, relational(), { roles: graph, grants, assignments: store, extensions }));
  }

  const holds = async (residual: ResourceFilter, principal: Principal, f: ResourceRef) => (await evaluateFilter(residual, row(f), { principal, ref: f, context: relational() })) === true;

  const assignmentArb = fc.record({ role: fc.constantFrom(...ROLE_NAMES, 'ghost'), scope: fc.constantFrom(...SCOPES), bot: fc.boolean(), expired: fc.boolean() });
  // undefined: no ceiling; [] included.
  const ceilingArb = fc.option(fc.subarray(ROLE_NAMES), { nil: undefined });

  it('a scoped role becomes an under term of its scope', async () => {
    const store = new MemoryAssignmentStore([assignment('a1', 'viewer', P1)]);
    const typeLevel = (await vote(alice, store, { type: 'file' }, [])).permitWhen;
    expect(typeLevel).to.deep.equal({ op: 'under', scopes: [P1] });
    const listed: string[] = [];
    for (const f of FILES) if (await holds(typeLevel, alice, f)) listed.push(f.id!);
    expect(listed).to.deep.equal(['f1', 'f2']);
  });

  it('for random assignments and ceilings, the type-level residual holds on a row exactly when its check permits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(assignmentArb, { maxLength: 6 }), ceilingArb, async (drawn, roles) => {
        const rows = drawn.map((d, i) => assignment(`a${i}`, d.role, d.scope, { ...(d.bot ? { subject: bot } : {}), ...(d.expired ? { expiresAt: NOW } : {}) }));
        const store = new MemoryAssignmentStore(rows);
        const principal = roles === undefined ? withCompanions(alice, [bot]) : withCeiling(withCompanions(alice, [bot]), { roles });
        for (const extensions of [[], createRbacExtensions({ roles: new MemoryRoleStore(ROLES), assignments: store })]) {
          for (const e of extensions) e.compile?.(graph, grants, registry);
          const typeLevel = (await vote(principal, store, { type: 'file' }, extensions)).permitWhen;
          const got: string[] = [];
          const want: string[] = [];
          for (const f of FILES) {
            if (await holds(typeLevel, principal, f)) got.push(f.id!);
            if (await holds((await vote(principal, store, f, extensions)).permitWhen, principal, f)) want.push(f.id!);
          }
          expect(got, JSON.stringify({ rows, roles, typeLevel })).to.deep.equal(want);
        }
      }),
      { numRuns: 150 },
    );
  });
});
