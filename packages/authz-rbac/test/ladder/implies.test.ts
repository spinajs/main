import { AuthzConfigError, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, PermissionInput, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ImpliesExtension, LadderExtension, MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RbacModel, RbacService, compileImplies, compileRoles, createRbacExtensions, liveAssignments, rbacAssignmentExtension } from '../../src/index.js';
import type { GrantDef, LadderDef, RbacExtension, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });

const TYPES = ['org', 'project', 'file'];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:edit', 'project:settings', 'project:archive', 'org:audit'].map((name) => ({ name, types: TYPES }));
const LADDERS: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }];
const ROLES: RoleDef[] = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('org.admin', ['project:archive'], { implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['code'], bypass: ['restrict', 'cap'] }] }), role('org.owner', ['org:audit'], { extends: ['org.admin'] }), role('org.lead', [], { implies: [{ role: 'editor', at: 'descendants' }], scopeTypes: ['org'] }), role('team.lead', [], { implies: [{ role: 'editor', at: 'descendants' }] })];

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

const graphOf = (roles: readonly RoleDef[]) => compileRoles(roles, [], {});
function refused(roles: readonly RoleDef[], ...parts: string[]): void {
  expect(() => compileImplies(graphOf(roles))).to.throw(AuthzConfigError);
  try {
    compileImplies(graphOf(roles));
  } catch (e) {
    for (const part of parts) expect((e as Error).message).to.contain(part);
  }
}

const scopes = new FakeScopeResolver({ types: TYPES, nodes: [{ ref: O1 }, { ref: O2 }, { ref: P1, parent: O1 }, { ref: f1, parent: P1 }] });
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(assignments: readonly Assignment[], opts: { extensions?: (o: { roles: MemoryRoleStore; assignments: MemoryAssignmentStore }) => readonly RbacExtension[]; roles?: readonly RoleDef[] } = {}) {
  const stores = { roles: new MemoryRoleStore(opts.roles ?? ROLES, LADDERS), assignments: new MemoryAssignmentStore(assignments) };
  const m = new RbacModel({ ...stores, ...(opts.extensions ? { extensions: opts.extensions(stores) } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}

const vote = async (m: RbacModel, permission: string, resource: ResourceRef, principal: Principal = alice): Promise<Vote> => m.evaluate({ principal, permission, resource }, ctx());
const held = async (m: RbacModel, at: ResourceRef, principal: Principal = alice) => liveAssignments(await m.inputAt(principal, at, ctx()));

describe('authz-rbac implied roles (B32)', () => {
  describe('compile and boot rules (design §6.5 rule 9)', () => {
    it('a role implies what every role of its closure implies, in closure order', () => {
      const index = compileImplies(compileRoles(ROLES, LADDERS, { extraEdges: new LadderExtension().extraEdges }));
      expect(index.of('org.owner').map((e) => [e.role, e.at])).to.deep.equal([['maintainer', 'self-and-descendants']]);
      expect(index.of('org.admin')[0]).to.deep.include({ tags: ['code'], bypass: ['restrict', 'cap'] });
      expect(index.of('team.lead')[0]).to.deep.include({ role: 'editor', at: 'descendants', tags: [], bypass: [] });
      expect(index.of('maintainer')).to.deep.equal([]);
      expect(index.of('ghost')).to.deep.equal([]);
    });

    it('a ladder role passes implies on to the higher roles of its ladder', () => {
      const roles = [role('viewer', [], { ladder: 'project', implies: [{ role: 'reader', at: 'self-and-descendants' }] }), role('editor', [], { ladder: 'project' }), role('reader', [])];
      const index = compileImplies(compileRoles(roles, [{ name: 'project', roles: ['viewer', 'editor'] }], { extraEdges: new LadderExtension().extraEdges }));
      expect(index.of('editor').map((e) => e.role)).to.deep.equal(['reader']);
    });

    it('implies naming an unknown role', () => {
      refused([role('owner', [], { implies: [{ role: 'ghost', at: 'descendants' }] })], 'rbac', "'owner'", "'ghost'", 'rule 9');
    });

    it('a malformed list or entry: not an array, no role, a bad at, bad tags, a bypass of the ceiling', () => {
      const bad = (implies: unknown, ...parts: string[]) => refused([role('viewer', []), role('owner', [], { implies } as unknown as Partial<RoleDef>)], 'rbac', "'owner'", ...parts);
      bad('viewer', 'implies');
      bad([{ at: 'descendants' }], 'no role');
      bad([{ role: 'viewer', at: 'everywhere' }], 'at');
      bad([{ role: 'viewer', at: 'descendants', tags: [''] }], 'tags');
      bad([{ role: 'viewer', at: 'descendants', bypass: ['ceiling'] }], 'bypass');
    });

    it('implied roles do not chain: an implied role that implies roles itself is refused', () => {
      refused([role('a', [], { implies: [{ role: 'b', at: 'descendants' }] }), role('b', [], { implies: [{ role: 'c', at: 'descendants' }] }), role('c', [])], "'a'", "'b'", "'c'", 'chain');
      refused([role('a', [], { implies: [{ role: 'b', at: 'descendants' }] }), role('b', [], { extends: ['x'] }), role('x', [], { implies: [{ role: 'c', at: 'descendants' }] }), role('c', [])], "'a'", "'b'", 'chain');
      refused([role('a', [], { implies: [{ role: 'a', at: 'descendants' }] })], "'a'", 'chain');
    });

    it('the default model checks implies without ladders: its grant index (the boot contributor) refuses them', async () => {
      expect(createRbacExtensions({ roles: new MemoryRoleStore(), assignments: new MemoryAssignmentStore() }).some((e) => e instanceof ImpliesExtension)).to.equal(true);
      const m = new RbacModel({ roles: new MemoryRoleStore([role('owner', [], { implies: [{ role: 'ghost', at: 'descendants' }] })]), assignments: new MemoryAssignmentStore(), extensions: [new ImpliesExtension()], log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      expect(() => m.grantIndex()).to.throw(AuthzConfigError, "'ghost'");
    });
  });

  describe('collect adds implied roles', () => {
    it('at the scope and below, with the declared tags, bypass marks, expiry and the implying assignment', async () => {
      const m = await model([assignment('a1', 'org.admin', O1, { expiresAt: new Date(NOW.getTime() + HOUR), tags: ['own'] })]);
      const { live } = await held(m, f1);
      const implied = live.find((l) => l.impliedBy)!;
      expect(live.map((l) => [l.role, l.rank])).to.deep.equal([
        ['org.admin', undefined],
        ['maintainer', 2],
      ]);
      expect(implied.scope).to.deep.equal(O1);
      expect(implied.tags).to.deep.equal(['code']);
      expect([...implied.bypass]).to.deep.equal(['restrict', 'cap']);
      expect(implied.expiresAt).to.deep.equal(new Date(NOW.getTime() + HOUR));
      expect(implied.impliedBy).to.equal(live[0]);
      expect(implied.assignment.id).to.equal('a1');
      expect(live[0].bypass.size).to.equal(0);
    });

    it('a role that extends an implying role implies its role too (B12)', async () => {
      const m = await model([assignment('a1', 'org.owner', O1)]);
      expect((await vote(m, 'project:settings', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('Vote.roles shows the implied rank: an org admin is maintainer on its projects (§16.3)', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      const v = await vote(m, 'project:settings', P1);
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v.roles).to.deep.equal({ project: 'maintainer' });
      expect((await vote(m, 'project:settings', O1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'project:settings', O2)).permitWhen).to.deep.equal(FALSE);
    });

    it("at: 'descendants' leaves the scope itself out", async () => {
      const m = await model([assignment('a1', 'team.lead', O1)]);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:edit', P1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:edit', O1)).permitWhen).to.deep.equal(FALSE);
    });

    it("at: 'descendants' of GLOBAL holds on every resource but not on $global itself", async () => {
      const m = await model([assignment('a1', 'team.lead')]);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:edit', GLOBAL)).permitWhen).to.deep.equal(FALSE);
    });

    it('an implied role must pass ceiling.roles itself, and the implying role too (D19)', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      expect((await vote(m, 'project:settings', P1, withCeiling(alice, { roles: ['org.admin'] }))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'project:archive', P1, withCeiling(alice, { roles: ['org.admin'] }))).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'project:settings', P1, withCeiling(alice, { roles: ['maintainer'] }))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'project:settings', P1, withCeiling(alice, { roles: ['org.admin', 'maintainer'] }))).permitWhen).to.deep.equal(TRUE);
    });

    it('a model without the implies table adds nothing', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)], { extensions: () => [new LadderExtension()] });
      expect((await vote(m, 'project:settings', P1)).permitWhen).to.deep.equal(FALSE);
    });
  });

  describe('type-level requests', () => {
    it('a GLOBAL holder implies its role on every row, also for descendants', async () => {
      const m = await model([assignment('a1', 'team.lead')]);
      expect((await vote(m, 'file:edit', { type: 'file' })).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:edit', { type: 'org' })).permitWhen).to.deep.equal(TRUE);
    });

    it('a scoped holder puts its implied role in the scoped holders, under its scope', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      expect((await vote(m, 'project:settings', { type: 'project' })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
      expect((await vote(m, 'project:settings', { type: 'org' })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
    });

    it("at: 'descendants': rows of the scope's own type leave the scope out; rows of other types cannot be it", async () => {
      const m = await model([assignment('a1', 'team.lead', O1)]);
      expect((await vote(m, 'file:edit', { type: 'org' })).permitWhen).to.deep.equal({
        op: 'and',
        args: [
          { op: 'under', scopes: [O1] },
          { op: 'cmp', field: 'id', cmp: 'ne', value: 'o1' },
        ],
      });
      expect((await vote(m, 'file:edit', { type: 'file' })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
    });

    it('a holder at S and an onlyBelow holder at S give the plain under(S) term', async () => {
      const m = await model([assignment('a1', 'org.admin', O1), assignment('a2', 'team.lead', O1)]);
      expect((await vote(m, 'file:edit', { type: 'org' })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
    });

    it('native:rbac.assignment names the stored role, and fails closed where it would admit the scope itself', async () => {
      const native = (rows: readonly Assignment[]) => model(rows, { extensions: (o) => [...createRbacExtensions({ ...o }), rbacAssignmentExtension(o)] });
      const admin = await native([assignment('a1', 'org.admin', O1)]);
      expect((await vote(admin, 'project:settings', { type: 'project' })).permitWhen).to.deep.equal({ op: RBAC_ASSIGNMENT_OP, args: { v: 1, subjects: [{ type: 'user', id: 'alice' }], roles: ['org.admin'] } });
      // org.lead may be assigned at org scopes only, so on file rows "below the scope" is exact.
      const lead = await native([assignment('a1', 'org.lead', O1)]);
      expect((await vote(lead, 'file:edit', { type: 'file' })).permitWhen).to.deep.equal({ op: RBAC_ASSIGNMENT_OP, args: { v: 1, subjects: [{ type: 'user', id: 'alice' }], roles: ['org.lead'] } });
      let thrown: unknown;
      try {
        await vote(lead, 'file:edit', { type: 'org' });
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).to.contain('below its scope only');
      // team.lead has no scopeTypes, so it may sit at an org or a file: both lists fail closed.
      const team = await native([assignment('a1', 'team.lead', O1)]);
      for (const type of ['org', 'file']) {
        let refused: unknown;
        try {
          await vote(team, 'file:edit', { type });
        } catch (e) {
          refused = e;
        }
        expect((refused as Error | undefined)?.message, type).to.contain('below its scope only');
      }
    });
  });

  describe('RbacService and summarize', () => {
    it('rolesOf and summarize list the implied role at the holder scope', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      const roles = await new RbacService(m).rolesOf(alice, P1, { ctx: ctx() });
      expect(roles.map((r) => [r.role, r.assignment])).to.deep.equal([
        ['org.admin', 'a1'],
        ['maintainer', 'a1'],
      ]);
      const summary = await m.summarize(alice, P1, ctx());
      expect(summary.roles!.map((r) => r.role)).to.deep.equal(['org.admin', 'maintainer']);
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:edit', 'file:read', 'project:archive', 'project:settings']);
    });

    it("covers: wanting a role wants what it implies; role names held everywhere hold what they imply at 'self-and-descendants'", async () => {
      const service = new RbacService(await model([]));
      expect(service.covers(['org.admin'], ['org.admin'])).to.equal(true);
      expect(service.covers(['org.owner'], ['maintainer'])).to.equal(true);
      expect(service.covers(['team.lead'], ['team.lead'])).to.equal(false);
      expect(service.covers(['team.lead', 'editor'], ['team.lead'])).to.equal(true);
      expect(service.covers([], ['org.admin'])).to.equal(false);
    });

    it('covers of a principal does not expand its names again: an implied role its ceiling drops stays out', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      const service = new RbacService(m);
      expect(await service.coversAt(withCeiling(alice, { roles: ['org.admin'] }), ['maintainer'], P1, ctx())).to.equal(false);
    });

    it('coversAt: an org admin holds maintainer on its projects and so covers it there, not at another org', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      const service = new RbacService(m);
      expect(await service.coversAt(alice, ['maintainer'], P1, ctx())).to.equal(true);
      expect(await service.coversAt(alice, ['maintainer'], O2, ctx())).to.equal(false);
    });
  });
});
