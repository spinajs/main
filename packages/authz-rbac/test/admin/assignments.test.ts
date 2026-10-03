import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzConfigError, SYSTEM } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, PrincipalRef } from '@spinajs/authz';

import { plannedRemovals } from '../../src/index.js';

import type { AssignmentSubject } from '../../src/index.js';
import { G, GR, HOUR, LADDERS, O1, P1, P2, ROLES, START, StaticRoleStore, failure, installHost, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const DAVE: PrincipalRef = { type: 'user', id: 'dave' };
const ERIN: PrincipalRef = { type: 'user', id: 'erin' };
const MEMBERS: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };

const grant = (r: string, scope = P1, subject: AssignmentSubject = DAVE, extra: Partial<Extract<AuthzCommand, { kind: 'assignment.grant' }>> = {}): AuthzCommand => ({ kind: 'assignment.grant', subject, role: r, scope, ...extra });

describe('RBAC assignment and subject set commands', function () {
  this.timeout(20000);
  let d: RbacDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await rbacDomain();
  });

  const live = async (subject: AssignmentSubject = DAVE) => d.assignments.forSubjects([subject], START);

  describe('assignment.grant', () => {
    it('stores the assignment and answers with its id, tags, events, audit and the row', async () => {
      const [r] = ok(await d.admin.execute(alice, [grant('viewer', P1, DAVE, { tags: ['inspect', 'code', 'code'] })]));
      const [row] = await live();
      expect(r).to.deep.equal({ ok: true, kind: 'assignment.grant', id: row.id, affected: 1 });
      expect(row).to.deep.include({ subject: DAVE, role: 'viewer', scope: P1, tags: ['code', 'inspect'], expiresAt: null, grantedBy: { type: 'user', id: 'alice' } });
      expect(d.bus.published).to.have.length(1);
      expect(d.bus.published[0].tags).to.deep.equal(['subject:user:dave']);
      expect(d.sink.events.map((e) => [e.type, e.data])).to.deep.equal([['RoleAssigned', { id: row.id, subject: DAVE, role: 'viewer', scope: P1, tags: ['code', 'inspect'], expiresAt: null }]]);
      expect(d.sink.events[0].actor).to.deep.equal({ type: 'user', id: 'alice' });
      expect(d.audit.of('admin')).to.have.length(1);
      expect(d.audit.of('admin')[0]).to.deep.include({ permission: 'authz:assignments.manage', resource: P1 });
    });

    it('assign returns the Assignment row', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, expiresAt: new Date(START.getTime() + HOUR) });
      expect(a).to.deep.include({ subject: DAVE, role: 'viewer', scope: P1, tags: [], source: 'memory' });
      expect(a.expiresAt?.getTime()).to.equal(START.getTime() + HOUR);
      expect((await d.assignments.byId(a.id))?.id).to.equal(a.id);
    });

    it('a re-grant keeps the id and replaces tags and expiry', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, tags: ['a'] });
      const b = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, tags: ['b'], expiresAt: new Date(START.getTime() + HOUR) });
      expect(b.id).to.equal(a.id);
      expect(b.tags).to.deep.equal(['b']);
      expect((await d.assignments.find({ at: START })).total).to.equal(1);
    });

    it('grants to a subject set; its cache tag is the set role', async () => {
      const a = await d.admin.assign(alice, { subject: MEMBERS, role: 'editor', scope: P1 });
      expect((await d.assignments.forSubjects([{ set: { role: 'org.member', scope: { type: 'org', id: 'o1' } } }], START)).map((r) => r.id)).to.deep.equal([a.id]);
      expect(d.bus.published[0].tags).to.deep.equal(['role:org.member']);
    });

    it('a GLOBAL grant counts as scope type $global', async () => {
      ok(await d.admin.execute(alice, [grant('plain', G)]));
      expect(failure(await d.admin.execute(alice, [grant('org.admin', G)]))).to.deep.equal({ at: 0, code: 'wrong_scope_type', field: 'role' });
    });

    const refusals: [string, AuthzCommand, { code: string; field?: string }][] = [
      ['an unknown role', grant('ghost'), { code: 'unknown_role', field: 'role' }],
      ['a role that is not assignable', grant('package'), { code: 'not_assignable', field: 'role' }],
      ['a role held at other scope types', grant('org.admin', P1), { code: 'wrong_scope_type', field: 'role' }],
      ['a subject set of an unknown role', grant('viewer', P1, { set: { role: 'ghost', scope: O1 } }), { code: 'unknown_role', field: 'subject.set.role' }],
      ['a subject set of a role that is not a subject set role', grant('viewer', P1, { set: { role: 'plain', scope: O1 } }), { code: 'unknown_role', field: 'subject.set.role' }],
      ['replaceLadder with a role on no ladder', grant('plain', P1, DAVE, { replaceLadder: true }), { code: 'unknown_ladder', field: 'role' }],
      ['a tag with a comma', grant('viewer', P1, DAVE, { tags: ['a,b'] }), { code: 'invalid_command', field: 'tags' }],
      ['an empty tag', grant('viewer', P1, DAVE, { tags: [''] }), { code: 'invalid_command', field: 'tags' }],
      ['an invalid date', grant('viewer', P1, DAVE, { expiresAt: new Date(NaN) }), { code: 'invalid_command', field: 'expiresAt' }],
      ['no subject', { kind: 'assignment.grant', role: 'viewer', scope: P1 } as unknown as AuthzCommand, { code: 'invalid_command', field: 'subject' }],
      ['no scope', { kind: 'assignment.grant', subject: DAVE, role: 'viewer' } as unknown as AuthzCommand, { code: 'invalid_command', field: 'scope' }],
      ['a type-level scope', grant('viewer', { type: 'project' }), { code: 'invalid_command', field: 'scope' }],
      ['an expiry that is not after now', grant('viewer', P1, DAVE, { expiresAt: START }), { code: 'invalid_command', field: 'expiresAt' }],
      ['a share link as the subject', grant('viewer', P1, { type: 'link', id: 'l1' }), { code: 'conflict', field: 'subject' }],
    ];
    for (const [what, c, expected] of refusals) {
      it(`refuses ${what}`, async () => {
        expect(failure(await d.admin.execute(SYSTEM, [c]))).to.deep.equal({ at: 0, ...expected });
        expect((await d.assignments.find({ at: START, includeExpired: true })).total).to.equal(0);
      });
    }

    it('the actor needs authz:assignments.manage at the scope, unconditionally', async () => {
      ok(await d.admin.execute(bob, [grant('viewer', P1)]));
      expect(failure(await d.admin.execute(bob, [grant('viewer', P2)])).code).to.equal('forbidden');
      expect(failure(await d.admin.execute(carol, [grant('viewer', P1)])).code).to.equal('forbidden');
    });

    it("replaceLadder revokes the subject's other roles of that ladder at exactly that scope", async () => {
      const viewer = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const plain = await d.admin.assign(alice, { subject: DAVE, role: 'plain', scope: P1 });
      const elsewhere = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      const other = await d.admin.assign(alice, { subject: ERIN, role: 'viewer', scope: P1 });
      d.sink.batches.length = 0;
      const [r] = ok(await d.admin.execute(alice, [grant('editor', P1, DAVE, { replaceLadder: true })]));
      expect(r.affected).to.equal(2);
      expect((await live()).map((a) => a.role).sort()).to.deep.equal(['editor', 'plain', 'viewer']);
      expect(await d.assignments.byId(viewer.id)).to.equal(null);
      for (const kept of [plain, elsewhere, other]) expect(await d.assignments.byId(kept.id)).to.not.equal(null);
      expect(d.sink.events.map((e) => [e.type, e.data.role])).to.deep.equal([
        ['RoleRevoked', 'viewer'],
        ['RoleAssigned', 'editor'],
      ]);
    });
  });

  describe('assignment.revoke and revokeWhere', () => {
    it('revoke removes the row, at the row scope, expired rows too', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, expiresAt: new Date(START.getTime() + 1) });
      d.clock.advance(HOUR);
      d.bus.published.length = 0;
      const [r] = ok(await d.admin.execute(bob, [{ kind: 'assignment.revoke', id: a.id }]));
      expect(r).to.deep.equal({ ok: true, kind: 'assignment.revoke', id: a.id, affected: 1 });
      expect(await d.assignments.byId(a.id)).to.equal(null);
      expect(d.bus.published[0].tags).to.deep.equal(['subject:user:dave']);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'RoleRevoked', data: { id: a.id, subject: DAVE, role: 'viewer', scope: P1 } });
    });

    it('revoke of an unknown id is not_found; of a row elsewhere forbidden', async () => {
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revoke', id: 'nope' }]))).to.deep.equal({ at: 0, code: 'not_found', field: 'id' });
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      expect(failure(await d.admin.execute(bob, [{ kind: 'assignment.revoke', id: a.id }])).code).to.equal('forbidden');
      expect((await rejection(d.admin.revoke(alice, 'nope'))) as AuthzAdminFailure).to.include({ code: 'not_found' });
    });

    it('revokeWhere revokes every live match at the scope', async () => {
      const keepExpired = await d.admin.assign(alice, { subject: ERIN, role: 'editor', scope: P1, expiresAt: new Date(START.getTime() + 1) });
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      d.clock.advance(HOUR);
      await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      await d.admin.assign(alice, { subject: DAVE, role: 'plain', scope: P1 });
      await d.admin.assign(alice, { subject: ERIN, role: 'viewer', scope: P1 });
      const p2 = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      const [byRole] = ok(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: P1, role: 'viewer', subject: DAVE }]));
      expect(byRole.affected).to.equal(1);
      d.bus.published.length = 0;
      const [all] = ok(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: P1 }]));
      expect(all.affected).to.equal(2);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['subject:user:dave', 'subject:user:erin']);
      const left = (await d.assignments.find({ at: START, includeExpired: true })).items;
      expect(
        left
          .filter((a) => (a.subject as PrincipalRef).type !== 'link')
          .map((a) => a.id)
          .sort(),
      ).to.deep.equal([keepExpired.id, p2.id].sort());
      // The link's grant goes with its link, never through revokeWhere.
      expect(await d.assignments.forSubjects([{ type: 'link', id: link.id }], START)).to.have.length(1);
      const [none] = ok(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: P1 }]));
      expect(none.affected).to.equal(0);
    });

    it('revokeWhere needs a scope and the permission there', async () => {
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere' } as unknown as AuthzCommand]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'scope' });
      expect(failure(await d.admin.execute(bob, [{ kind: 'assignment.revokeWhere', scope: P2 }])).code).to.equal('forbidden');
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: P1, subject: { type: 'link', id: 'l1' } }]))).to.deep.equal({ at: 0, code: 'conflict', field: 'subject' });
    });

    it('revokeWhere of a set subject checks its shape only, so rows of a role dropped from config can go', async () => {
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: P1, subject: { set: { role: 'ghost', scope: O1 } } }]));
      expect(r.affected).to.equal(0);
    });

    it("id-only commands refuse a share link's grant", async () => {
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      const [grant] = await d.assignments.forSubjects([{ type: 'link', id: link.id }], START);
      for (const c of [
        { kind: 'assignment.revoke', id: grant.id },
        { kind: 'assignment.setTags', id: grant.id, tags: ['x'] },
        { kind: 'assignment.setExpiry', id: grant.id, expiresAt: null },
      ] as AuthzCommand[]) {
        expect(failure(await d.admin.execute(alice, [c]))).to.deep.equal({ at: 0, code: 'conflict', field: 'id' });
      }
      expect(await d.assignments.byId(grant.id)).to.not.equal(null);
    });
  });

  describe('tags and expiry', () => {
    it('setTags, addTags and removeTags keep tags normalised and emit AssignmentChanged', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, tags: ['b'] });
      await d.admin.setTags(alice, a.id, ['c', 'a', 'c']);
      expect((await d.assignments.byId(a.id))?.tags).to.deep.equal(['a', 'c']);
      ok(await d.admin.execute(alice, [{ kind: 'assignment.addTags', id: a.id, tags: ['b', 'a'] }]));
      expect((await d.assignments.byId(a.id))?.tags).to.deep.equal(['a', 'b', 'c']);
      ok(await d.admin.execute(alice, [{ kind: 'assignment.removeTags', id: a.id, tags: ['a', 'zz'] }]));
      expect((await d.assignments.byId(a.id))?.tags).to.deep.equal(['b', 'c']);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'AssignmentChanged', data: { id: a.id, subject: DAVE, role: 'viewer', scope: P1, tags: ['b', 'c'], expiresAt: null } });
      expect(d.bus.published.at(-1)!.tags).to.deep.equal(['subject:user:dave']);
    });

    it('tag commands refuse unknown ids and malformed tags', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.setTags', id: 'nope', tags: [] }])).code).to.equal('not_found');
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.addTags', id: a.id, tags: ['x,y'] }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'tags' });
    });

    it('setExpiry sets and clears the expiry', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const at = new Date(START.getTime() + HOUR);
      ok(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: a.id, expiresAt: at }]));
      expect((await d.assignments.byId(a.id))?.expiresAt?.getTime()).to.equal(at.getTime());
      expect((d.sink.events.at(-1)!.data.expiresAt as Date).getTime()).to.equal(at.getTime());
      ok(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: a.id, expiresAt: null }]));
      expect((await d.assignments.byId(a.id))?.expiresAt).to.equal(null);
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: a.id } as unknown as AuthzCommand]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'expiresAt' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: 'nope', expiresAt: null }])).code).to.equal('not_found');
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: a.id, expiresAt: START }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'expiresAt' });
    });

    it('an expired assignment no longer counts for forSubjects', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      ok(await d.admin.execute(alice, [{ kind: 'assignment.setExpiry', id: a.id, expiresAt: new Date(START.getTime() + 1) }]));
      expect(await d.assignments.forSubjects([DAVE], new Date(START.getTime() + HOUR))).to.deep.equal([]);
      expect(await d.assignments.byId(a.id)).to.not.equal(null);
    });
  });

  describe('subject sets', () => {
    const add = (member: PrincipalRef, role = 'group.member', scope = GR): AuthzCommand => ({ kind: 'set.addMember', set: { role, scope }, member });

    it('set.addMember assigns the set role to the member at the set scope; removeMember revokes it', async () => {
      const [r] = ok(await d.admin.execute(alice, [add(DAVE)]));
      const [row] = await live();
      expect(row).to.deep.include({ id: r.id, subject: DAVE, role: 'group.member', scope: GR });
      expect(d.sink.events.at(-1)!.type).to.equal('RoleAssigned');
      expect(d.audit.of('admin')[0]).to.deep.include({ resource: GR });
      const [again] = ok(await d.admin.execute(alice, [add(DAVE)]));
      expect(again.id).to.equal(r.id);
      ok(await d.admin.execute(alice, [{ kind: 'set.removeMember', set: { role: 'group.member', scope: GR }, member: DAVE }]));
      expect(await live()).to.deep.equal([]);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'RoleRevoked' });
    });

    it('a member of a set is reached through the set subject', async () => {
      await d.admin.assign(alice, { subject: { set: { role: 'group.member', scope: GR } }, role: 'editor', scope: P1 });
      ok(await d.admin.execute(alice, [add(DAVE)]));
      const memberships = (await live()).filter((a) => a.role === 'group.member');
      const viaSets = await d.assignments.forSubjects(
        memberships.map((m) => ({ set: { role: m.role, scope: m.scope } })),
        START,
      );
      expect(viaSets.map((a) => a.role)).to.deep.equal(['editor']);
    });

    it('refuses sets of unknown, non-set and unassignable roles, wrong scope types and missing members', async () => {
      expect(failure(await d.admin.execute(alice, [add(DAVE, 'ghost')]))).to.deep.equal({ at: 0, code: 'unknown_role', field: 'set.role' });
      expect(failure(await d.admin.execute(alice, [add(DAVE, 'plain')]))).to.deep.equal({ at: 0, code: 'unknown_role', field: 'set.role' });
      expect(failure(await d.admin.execute(alice, [add(DAVE, 'locked.set')]))).to.deep.equal({ at: 0, code: 'not_assignable', field: 'set.role' });
      expect(failure(await d.admin.execute(alice, [add(DAVE, 'group.member', P1)]))).to.deep.equal({ at: 0, code: 'wrong_scope_type', field: 'set.role' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR } } as unknown as AuthzCommand]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'member' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'set.removeMember', set: { role: 'group.member', scope: GR }, member: DAVE }]))).to.deep.equal({ at: 0, code: 'not_found', field: 'member' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'set.removeMember', set: { role: 'ghost', scope: GR }, member: DAVE }]))).to.deep.equal({ at: 0, code: 'not_found', field: 'member' });
      expect(failure(await d.admin.execute(alice, [add({ type: 'link', id: 'l1' })]))).to.deep.equal({ at: 0, code: 'conflict', field: 'member' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: DAVE, expiresAt: START }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'expiresAt' });
    });

    it('the permission is checked at the set scope', async () => {
      expect(failure(await d.admin.execute(bob, [add(DAVE)])).code).to.equal('forbidden');
      expect(failure(await d.admin.execute(bob, [add(DAVE, 'org.member', O1)])).code).to.equal('forbidden');
    });
  });

  describe('configuration', () => {
    it('merges the role definitions of every RoleStore', async () => {
      await resetHost();
      d = await rbacDomain('test', { roleStores: [new StaticRoleStore('a', ROLES, LADDERS), new StaticRoleStore('b', [{ name: 'extra', extends: [], grants: [], assignable: true, source: 'b' }])] });
      ok(await d.admin.execute(alice, [grant('extra'), grant('viewer')]));
    });

    it('a role defined twice is an AuthzConfigError', async () => {
      await resetHost();
      d = await rbacDomain('test', { roleStores: [new StaticRoleStore('a', ROLES, LADDERS), new StaticRoleStore('b', [ROLES[0]])] });
      expect(await rejection(d.admin.execute(alice, [grant('viewer')]))).to.be.instanceOf(AuthzConfigError);
    });

    it('no RoleStore or no AdminAssignmentStore is an AuthzConfigError', async () => {
      await resetHost();
      d = await rbacDomain('test', { without: ['roles'] });
      expect(await rejection(d.admin.execute(alice, [grant('viewer')]))).to.be.instanceOf(AuthzConfigError);
      await resetHost();
      d = await rbacDomain('test', { without: ['assignments'] });
      const e = await rejection(d.admin.execute(alice, [{ kind: 'assignment.revoke', id: 'x' }]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include('AdminAssignmentStore');
    });
  });

  describe('plannedRemovals', () => {
    const ctx = (): AdminCallContext => ({ domain: 'test', now: START, authz: d.service, actor: alice, container: d.container, dryRun: false });

    it('names the ladder rows a replaceLadder grant revokes', async () => {
      const viewer = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      await d.admin.assign(alice, { subject: DAVE, role: 'plain', scope: P1 });
      const planned = await plannedRemovals(grant('editor', P1, DAVE, { replaceLadder: true }), ctx());
      expect(planned.revoke.map((a) => a.id)).to.deep.equal([viewer.id]);
      expect(planned.expire).to.deep.equal([]);
      expect((await plannedRemovals(grant('editor', P1, DAVE), ctx())).revoke).to.deep.equal([]);
    });

    it('names the existing row whose expiry a grant or addMember moves to another date', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const later = new Date(START.getTime() + HOUR);
      expect((await plannedRemovals(grant('viewer', P1, DAVE, { expiresAt: later }), ctx())).expire.map((r) => r.id)).to.deep.equal([a.id]);
      expect((await plannedRemovals(grant('viewer', P1, DAVE), ctx())).expire).to.deep.equal([]);
      const m = await d.admin.execute(alice, [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: DAVE }]);
      expect((await plannedRemovals({ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: DAVE, expiresAt: later }, ctx())).expire.map((r) => r.id)).to.deep.equal([ok(m)[0].id]);
      expect((await plannedRemovals({ kind: 'assignment.setExpiry', id: a.id, expiresAt: later }, ctx())).expire.map((r) => r.id)).to.deep.equal([a.id]);
      expect(await plannedRemovals({ kind: 'assignment.setExpiry', id: a.id, expiresAt: null }, ctx())).to.deep.equal({ revoke: [], expire: [] });
    });

    it('names the rows revoke, revokeWhere, set.removeMember, a link role change and link.revoke remove', async () => {
      const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const b = await d.admin.assign(alice, { subject: ERIN, role: 'viewer', scope: P1 });
      await d.admin.assign(alice, { subject: ERIN, role: 'plain', scope: P2 });
      const m = ok(await d.admin.execute(alice, [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: DAVE }]))[0];
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      const [grantOfLink] = await d.assignments.forSubjects([{ type: 'link', id: link.id }], START);
      const ids = async (c: AuthzCommand) => {
        const p = await plannedRemovals(c, ctx());
        expect(p.expire).to.deep.equal([]);
        return p.revoke.map((r) => r.id);
      };
      expect(await ids({ kind: 'assignment.revoke', id: a.id })).to.deep.equal([a.id]);
      expect(await ids({ kind: 'assignment.revoke', id: 'gone' })).to.deep.equal([]);
      expect(await ids({ kind: 'assignment.revokeWhere', scope: P1 })).to.deep.equal([a.id, b.id]);
      expect(await ids({ kind: 'assignment.revokeWhere', scope: P1, subject: ERIN })).to.deep.equal([b.id]);
      expect(await ids({ kind: 'set.removeMember', set: { role: 'group.member', scope: GR }, member: DAVE })).to.deep.equal([m.id]);
      expect(await ids({ kind: 'link.update', id: link.id, role: 'editor' })).to.deep.equal([grantOfLink.id]);
      expect(await ids({ kind: 'link.update', id: link.id, role: 'viewer' })).to.deep.equal([]);
      expect(await ids({ kind: 'link.update', id: link.id, tags: ['x'] })).to.deep.equal([]);
      expect(await ids({ kind: 'link.revoke', id: link.id })).to.deep.equal([grantOfLink.id]);
      expect(await ids({ kind: 'link.revoke', id: 'gone' })).to.deep.equal([]);
      expect(await ids({ kind: 'assignment.addTags', id: a.id, tags: ['x'] })).to.deep.equal([]);
      expect(await ids({ kind: 'scope.forget', scope: P1 })).to.deep.equal([]);
    });
  });

  it('a batch that fails in apply leaves every store as it was', async () => {
    const a = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1, tags: ['t'] });
    await d.admin.assign(alice, { subject: ERIN, role: 'viewer', scope: P1 });
    const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
    const second = await d.admin.createLink(alice, { scope: P1, role: 'viewer', tags: ['k'] });
    await d.admin.putRule(alice, { id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor' });
    const snapshot = async () => JSON.stringify([await d.assignments.find({ at: START, includeExpired: true }), await d.links.find({}), await d.rules.find({})]);
    const before = await snapshot();
    const published = d.bus.published.length;
    const results = await d.admin.execute(alice, [grant('editor', P1, ERIN, { replaceLadder: true }), { kind: 'link.update', id: second.link.id, role: 'editor', expiresAt: new Date(START.getTime() + HOUR) }, { kind: 'assignment.setTags', id: a.id, tags: ['x'] }, { kind: 'link.create', scope: P2, role: 'viewer' }, { kind: 'link.revoke', id: link.id }, { kind: 'rule.put', rule: { id: 'r2', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer' } }, { kind: 'rule.delete', id: 'r1' }, { kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: DAVE }, { kind: 'assignment.revoke', id: a.id }, { kind: 'assignment.addTags', id: a.id, tags: ['late'] }]);
    expect(failure(results)).to.deep.equal({ at: 9, code: 'not_found', field: 'id' });
    expect(await snapshot()).to.equal(before);
    expect(d.bus.published.length).to.equal(published);
  });
});
