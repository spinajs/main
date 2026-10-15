import { AuthzConfigError, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, PermissionInput, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, groupPrincipal, servicePrincipal, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { DEFAULT_GROUP_PRINCIPAL, LadderExtension, MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService, RbacSubjectResolver, SetsExtension, compileRoles, createRbacExtensions, groupPrincipalConfig, subjectKey } from '../../src/index.js';
import type { GrantDef, LadderDef, RoleDef, SubjectResolver } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const G1: ResourceRef = { type: 'group', id: 'g1' };
const G2: ResourceRef = { type: 'group', id: 'g2' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const to = (who: { type: string; id: string }) => ({ type: who.type, id: who.id });
const assignment = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject, role: roleName, scope, source: 'test', ...extra });
const setOf = (roleName: string, scope: ResourceRef): AssignmentSubject => ({ set: { role: roleName, scope } });

const LADDERS: LadderDef[] = [{ name: 'org', roles: ['org.guest', 'org.member', 'org.admin'] }];
const ROLES: RoleDef[] = [role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org', subjectSet: true }), role('org.admin', [], { ladder: 'org' }), role('group.member', [], { subjectSet: true }), role('staff', [], { extends: ['org.member'] }), role('viewer', ['file:read']), role('editor', ['file:edit']), role('deleter', ['file:delete'])];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:edit', 'file:delete'].map((name) => ({ name, types: ['org', 'project', 'file'] }));

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

class CountingStore extends MemoryAssignmentStore {
  readonly reads: string[][] = [];
  override async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    this.reads.push(subjects.map(subjectKey));
    return super.forSubjects(subjects, at);
  }
}

const scopes = new FakeScopeResolver({ types: ['org', 'project', 'file', 'group'], nodes: [{ ref: O1 }, { ref: O2 }, { ref: P1, parent: O1 }, { ref: f1, parent: P1 }, { ref: G1 }, { ref: G2 }] });
const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(rows: readonly Assignment[], opts: { subjects?: SubjectResolver; config?: Record<string, unknown> } = {}) {
  const store = new CountingStore(rows);
  const base = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: store, ...(opts.subjects ? { subjects: opts.subjects } : {}) };
  const m = new RbacModel({ ...base, log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry(), config: opts.config ?? {} }));
  m.grantIndex();
  return { m, store };
}

const vote = async (m: RbacModel, permission: string, resource: ResourceRef, principal: Principal = alice, c: EvaluationContext = ctx()): Promise<Vote> => m.evaluate({ principal, permission, resource }, c);

// alice is an org member of O1 by assignment m1; the members of O1 view P1 (s1).
const SET_ROWS = [assignment('s1', setOf('org.member', O1), 'viewer', P1), assignment('s2', setOf('group.member', G1), 'editor', P1), assignment('n1', setOf('group.member', G1), 'group.member', G2), assignment('s3', setOf('group.member', G2), 'deleter', P1)];

describe('authz-rbac subject sets (B33)', () => {
  describe('RbacSubjectResolver', () => {
    it('gives the principal and its companions, each once', () => {
      const svc = servicePrincipal('svc', { companions: [alice, alice] });
      expect(new RbacSubjectResolver().subjects(svc)).to.deep.equal([to(svc), to(alice), { type: 'service', id: '*' }, { type: 'user', id: '*' }]);
    });

    it('a group principal speaks for its member set (authz.rbac.groupPrincipal); null turns it off', () => {
      const g1 = groupPrincipal('g1');
      expect(new RbacSubjectResolver().subjects(g1)).to.deep.equal([to(g1), setOf('group.member', G1), { type: 'group', id: '*' }]);
      expect(new RbacSubjectResolver({ groupPrincipal: { role: 'team', scopeType: 'team' } }).subjects(g1)).to.deep.equal([to(g1), setOf('team', { type: 'team', id: 'g1' }), { type: 'group', id: '*' }]);
      expect(new RbacSubjectResolver({ groupPrincipal: null }).subjects(g1)).to.deep.equal([to(g1), { type: 'group', id: '*' }]);
    });

    it('groupPrincipalConfig reads the config: absent or partial keeps the defaults, null turns it off', () => {
      const config = (groupPrincipal: unknown) => groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: groupPrincipal === undefined ? {} : { groupPrincipal } }));
      expect(config(undefined)).to.deep.equal(DEFAULT_GROUP_PRINCIPAL);
      expect(config(null)).to.equal(null);
      expect(config({ role: 'team', scopeType: 'team' })).to.deep.equal({ role: 'team', scopeType: 'team' });
      expect(config({ role: 'team' })).to.deep.equal({ role: 'team', scopeType: 'group' });
    });

    it('groupPrincipalConfig turns the mapping off for a non-object an unvalidated configuration holds, never on with the defaults', () => {
      for (const groupPrincipal of ['group.member', '', false, 0, ['group.member']]) {
        expect(groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: { groupPrincipal } })), JSON.stringify(groupPrincipal)).to.equal(null);
      }
    });

    it('groupPrincipalConfig warns when a malformed value turns the mapping off, not for null', () => {
      const warned: string[] = [];
      const log = { warn: (message: string) => warned.push(message) };
      groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: { groupPrincipal: 'group.member' } }), log);
      groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: { groupPrincipal: null } }), log);
      expect(warned).to.have.length(1);
      expect(warned[0]).to.contain('authz.rbac.groupPrincipal').and.contain('"group.member"');
    });

    describe('memberships', () => {
      const graph = compileRoles(ROLES, LADDERS, { extraEdges: new LadderExtension().extraEdges });
      const sets = (rows: readonly Assignment[]) => [...new RbacSubjectResolver().memberships(rows, graph, NOW)].map(([key, m]) => [key, m.via.map((v) => v.assignment)]);

      it('a live assignment of a subjectSet role, of a higher role of its ladder, or of a role extending it', () => {
        expect(sets([assignment('m1', to(alice), 'org.member', O1), assignment('m2', to(alice), 'org.admin', O1), assignment('m3', to(alice), 'staff', O2)])).to.deep.equal([
          [subjectKey(setOf('org.member', O1)), ['m1', 'm2']],
          [subjectKey(setOf('org.member', O2)), ['m3']],
        ]);
      });

      it('nothing from a lower role, an expired or refused row, or a row made to a set (one level)', () => {
        const refused = [role('closed', [], { subjectSet: true, assignable: false })];
        const g = compileRoles([...ROLES, ...refused], LADDERS, { extraEdges: new LadderExtension().extraEdges });
        const rows = [assignment('m1', to(alice), 'org.guest', O1), assignment('m2', to(alice), 'org.member', O2, { expiresAt: NOW }), assignment('m3', to(alice), 'closed', O1), assignment('n1', setOf('group.member', G1), 'group.member', G2)];
        expect([...new RbacSubjectResolver().memberships(rows, g, NOW)]).to.deep.equal([]);
      });
    });
  });

  describe('through the model', () => {
    const rows = (...extra: Assignment[]) => [...SET_ROWS, ...extra];

    it('an assignment to { set: R @ S } applies to a holder of R, or of a higher role, at S only', async () => {
      const { m } = await model(rows(assignment('m1', to(alice), 'org.member', O1), assignment('m2', to(userPrincipal('bob')), 'org.admin', O1), assignment('m3', to(userPrincipal('carol')), 'org.guest', O1), assignment('m4', to(userPrincipal('dave')), 'org.member', O2)));
      expect((await vote(m, 'file:read', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:read', f1, userPrincipal('bob'))).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:read', f1, userPrincipal('carol'))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'file:read', f1, userPrincipal('dave'))).permitWhen).to.deep.equal(FALSE);
    });

    it('a group principal gets its set; members get the group grants; sets are one level deep', async () => {
      const { m } = await model(rows(assignment('m5', to(userPrincipal('erin')), 'group.member', G1), assignment('m6', to(userPrincipal('gina')), 'group.member', G2)));
      expect((await vote(m, 'file:edit', f1, groupPrincipal('g1'))).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:edit', f1, userPrincipal('erin'))).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:delete', f1, userPrincipal('erin'))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'file:delete', f1, userPrincipal('gina'))).permitWhen).to.deep.equal(TRUE);
    });

    it("a companion's sets join the principal's", async () => {
      const { m } = await model(rows(assignment('m1', to(alice), 'org.member', O1)));
      expect((await vote(m, 'file:read', f1, servicePrincipal('svc', { companions: [alice] }))).permitWhen).to.deep.equal(TRUE);
    });

    it('the membership expiry bounds validUntil of a vote that used the set; the earlier of the two wins', async () => {
      // group.member is on no ladder, so only the membership can bound the vote.
      const { m } = await model(rows(assignment('m1', to(alice), 'group.member', G1, { expiresAt: later(HOUR) })));
      const v = await vote(m, 'file:edit', f1);
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v.roles).to.deep.equal({});
      expect(v.validUntil).to.deep.equal(later(HOUR));
      const { m: two } = await model([assignment('s1', setOf('org.member', O1), 'viewer', P1, { expiresAt: later(HOUR) }), assignment('m1', to(alice), 'org.member', O1, { expiresAt: later(2 * HOUR) }), assignment('m2', to(alice), 'org.admin', O1, { expiresAt: later(3 * HOUR) })]);
      expect((await vote(two, 'file:read', f1)).validUntil).to.deep.equal(later(HOUR));
      const { m: longest } = await model(rows(assignment('m1', to(alice), 'org.member', O1, { expiresAt: later(2 * HOUR) }), assignment('m2', to(alice), 'org.admin', O1, { expiresAt: later(3 * HOUR) })));
      expect((await vote(longest, 'file:read', f1)).validUntil).to.deep.equal(later(3 * HOUR));
    });

    it('a membership whose role ceiling.roles leaves out does not make the set a subject', async () => {
      const { m } = await model(rows(assignment('m1', to(alice), 'org.member', O1)));
      expect((await vote(m, 'file:read', f1, withCeiling(alice, { roles: ['viewer'] }))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'file:read', f1, withCeiling(alice, { roles: ['viewer', 'org.member'] }))).permitWhen).to.deep.equal(TRUE);
    });

    it('another SubjectResolver decides the subjects alone: no sets are added', async () => {
      const own: SubjectResolver = { subjects: (p: Principal) => [to(p)] };
      const { m } = await model(rows(assignment('m1', to(alice), 'org.member', O1)), { subjects: own });
      expect((await vote(m, 'file:read', f1)).permitWhen).to.deep.equal(FALSE);
    });

    it('summarize includes permissions reached through sets', async () => {
      const { m } = await model(rows(assignment('m1', to(alice), 'org.member', O1)));
      const summary = await m.summarize(alice, f1, ctx());
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:read']);
      expect(summary.roles!.map((r) => r.role)).to.deep.equal(['org.member', 'viewer']);
    });

    it('the default model holds SetsExtension and RbacSubjectResolver', async () => {
      expect(createRbacExtensions({ roles: new MemoryRoleStore(), assignments: new MemoryAssignmentStore() }).some((e) => e instanceof SetsExtension)).to.equal(true);
    });
  });

  describe('preload, cache and lists', () => {
    const rows = [...SET_ROWS, assignment('m1', to(alice), 'org.member', O1)];

    it('preload makes two store reads, the principal with its companions and then its sets; the request then reads nothing', async () => {
      const { m, store } = await model(rows);
      const c = ctx();
      await m.preload(alice, c);
      expect(store.reads).to.deep.equal([['user:alice', 'user:*'], [subjectKey(setOf('org.member', O1))]]);
      expect((await vote(m, 'file:read', f1, alice, c)).permitWhen).to.deep.equal(TRUE);
      const list = m.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file' } }, c);
      expect(list).to.not.be.instanceOf(Promise);
      expect((list as Vote).permitWhen).to.deep.equal({ op: 'under', scopes: [P1] });
      expect(store.reads).to.have.length(2);
    });

    it('a principal without sets makes one store read', async () => {
      const { m, store } = await model(rows);
      await m.preload(userPrincipal('zed'), ctx());
      expect(store.reads).to.have.length(1);
    });

    it('covers and heldNow answer from the preloaded sets, without IO; not preloaded throws', async () => {
      const { m } = await model(rows);
      expect(() => m.heldNow(alice, P1)).to.throw(AuthzConfigError, 'not preloaded');
      await m.preload(alice, ctx());
      expect(m.heldNow(alice, P1).map((l) => l.role)).to.deep.equal(['viewer']);
      expect(new RbacService(m).covers(alice, ['viewer'], P1)).to.equal(true);
    });

    it('invalidating the principal drops its sets too: the next preload reads both again', async () => {
      const { m, store } = await model(rows);
      await m.preload(alice, ctx());
      m.invalidate(['subject:user:alice']);
      await m.preload(alice, ctx());
      expect(store.reads).to.have.length(4);
    });
  });
});
