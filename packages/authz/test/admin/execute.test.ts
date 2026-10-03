import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzConfigError, DefaultAuthzAdmin, SYSTEM, UnknownPermission, adminActor, adminContainer } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzCommandResult, ResourceRef } from '@spinajs/authz';
import { FailingBus, HOUR, START, ThrowingAudit, ThrowingSink, adminConfig, adminDomain, installHost, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const erin = userPrincipal('erin');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const d1: ResourceRef = { type: 'doc', id: 'd1' };
const ALICE = { type: 'user', id: 'alice' };

const grant = (subject: string, role = 'editor', scope: ResourceRef = p1): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: subject }, role, scope });
const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const GRANT = 'assignment.grant';

const applies = (d: AdminDomain) => d.store.trace.filter((t) => t.startsWith('apply:')).length;
const adminAudit = (d: AdminDomain) => d.audit.of('admin');
const checked = (d: AdminDomain) => d.model.requests.map((r) => `${r.permission}@${r.resource.type}`);
const tick = () => new Promise((r) => setTimeout(r, 5));

function expectNothingAfterCommit(d: AdminDomain): void {
  expect(d.bus.published).to.deep.equal([]);
  expect(d.sink.batches).to.deep.equal([]);
  expect(adminAudit(d)).to.deep.equal([]);
}

describe('DefaultAuthzAdmin.execute', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  describe('a committed batch', () => {
    it('applies every command and returns one result per command', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'viewer')]);
      expect(d.admin).to.be.instanceOf(DefaultAuthzAdmin);
      expect(out).to.deep.equal([
        { ok: true, kind: GRANT, id: 'a1', affected: 1 },
        { ok: true, kind: GRANT, id: 'a2', affected: 1 },
      ]);
      expect([...d.store.rows.keys()]).to.deep.equal(['a1', 'a2']);
    });

    it('returns [] for an empty batch and publishes nothing', async () => {
      const d = await adminDomain();
      expect(await d.admin.execute(alice, [])).to.deep.equal([]);
      expect(d.backend.version('test')).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('passes handlers an AdminCallContext of the domain', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob')], { reason: 'onboarding' });
      const ctx = d.store.contexts[0] as AdminCallContext;
      expect(ctx.domain).to.equal('test');
      expect(ctx.now.getTime()).to.equal(START.getTime());
      expect(ctx.authz).to.equal(d.service);
      expect(ctx.reason).to.equal('onboarding');
      expect(ctx.dryRun).to.equal(false);
      expect(adminActor(ctx)).to.equal(alice);
      expect(adminContainer(ctx)).to.equal(d.container);
    });

    it('runs validate, validators and the permission check per command, then guard and apply per command', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob'), grant('dan')]);
      const phaseA = [`validate:${GRANT}`, `validator:${GRANT}`, `permission:${GRANT}`];
      const phaseB = [`guard:${GRANT}`, `apply:${GRANT}`];
      expect(d.store.trace).to.deep.equal([...phaseA, ...phaseA, ...phaseB, ...phaseB]);
      expect(checked(d)).to.deep.equal(['authz:assignments.manage@project', 'authz:assignments.manage@project']);
      expect(d.model.requests[0].principal).to.equal(alice);
    });

    it('lets the guard see the batch’s own earlier writes', async () => {
      const d = await adminDomain();
      await d.admin.execute(SYSTEM, [grant('bob', 'owner'), grant('dan', 'owner')]);
      const out = await d.admin.execute(alice, [revoke('a1'), revoke('a2')]);
      expect(out[1]).to.deep.equal({ ok: false, kind: 'assignment.revoke', error: { code: 'last_holder', message: 'the last owner stays' } });
      expect(d.store.rows.size).to.equal(2);
    });

    it('publishes exactly one change with the union of the tags', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob', 'editor'), grant('bob', 'viewer'), grant('dan', 'editor')]);
      expect(d.bus.published).to.have.length(1);
      const change = d.bus.published[0];
      expect(change).to.deep.equal({ domain: 'test', tags: ['subject:user:bob', 'role:editor', 'role:viewer', 'subject:user:dan'], actor: ALICE, at: START });
    });

    it('stamps events with the domain, the actor ref and the time, and strips tokens', async () => {
      const d = await adminDomain();
      d.clock.advance(1000);
      await d.admin.execute(alice, [grant('bob'), { kind: 'link.create', scope: p1, role: 'viewer' }]);
      expect(d.sink.batches).to.have.length(1);
      const at = new Date(START.getTime() + 1000);
      expect(d.sink.events).to.deep.equal([
        { type: 'RoleAssigned', domain: 'test', actor: ALICE, at, data: { id: 'a1', role: 'editor', scope: p1 } },
        { type: 'LinkCreated', domain: 'test', actor: ALICE, at, data: { id: 'a2', scope: p1 } },
      ]);
    });

    it('records one admin audit entry per command, with secrets removed', async () => {
      const d = await adminDomain();
      const link: AuthzCommand = { kind: 'link.create', scope: d1, role: 'viewer', attributes: { password: 'p', note: 'n', nested: { apiSecret: 's', keep: 1 }, list: [{ token: 't', ok: true }] } };
      const out = await d.admin.execute(alice, [grant('bob'), link], { reason: 'onboarding' });
      expect(out[1]).to.deep.equal({ ok: true, kind: 'link.create', id: 'a2', token: 'tok-a2', affected: 1 });
      expect(adminAudit(d)).to.deep.equal([
        { kind: 'admin', principal: ALICE, permission: 'authz:assignments.manage', resource: p1, reason: 'onboarding', command: grant('bob') },
        { kind: 'admin', principal: ALICE, permission: 'authz:links.manage', resource: d1, reason: 'onboarding', command: { kind: 'link.create', scope: d1, role: 'viewer', attributes: { note: 'n', nested: { keep: 1 }, list: [{ ok: true }] } } },
      ]);
      expect((link as { attributes: Record<string, unknown> }).attributes.password).to.equal('p');
    });

    it('bumps the version once per committed batch', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob'), grant('dan'), grant('eve')]);
      expect(d.backend.version('test')).to.equal(1);
      await d.admin.execute(bob, [grant('dan')]);
      await d.admin.execute(alice, [grant('dan')], { dryRun: true });
      expect(d.backend.version('test')).to.equal(1);
      await d.admin.execute(alice, [grant('dan')]);
      expect(d.backend.version('test')).to.equal(2);
    });
  });

  describe('a failed batch', () => {
    it('reports an unknown kind as not_found', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), { kind: 'policy.delete', id: 'x' }]);
      expect(out).to.have.length(2);
      expect(out[0]).to.deep.equal({ ok: true, kind: GRANT, affected: 0 });
      const failed = out[1] as Extract<AuthzCommandResult, { ok: false }>;
      expect(failed.ok).to.equal(false);
      expect(failed.kind).to.equal('policy.delete');
      expect(failed.error.code).to.equal('not_found');
      expect(failed.error.message).to.match(/policy\.delete/);
      expect(applies(d)).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('stops at a validate failure before the validators', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob', 'unknown')]);
      expect(out).to.deep.equal([{ ok: false, kind: GRANT, error: { code: 'unknown_role', message: 'role "unknown" does not exist', field: 'role' } }]);
      expect(d.store.trace).to.deep.equal([`validate:${GRANT}`]);
    });

    it('stops at a validator failure before the permission', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('external')]);
      expect(out).to.deep.equal([{ ok: false, kind: GRANT, error: { code: 'conflict', message: 'no external invites', field: 'subject' } }]);
      expect(d.store.trace).to.deep.equal([`validate:${GRANT}`, `validator:${GRANT}`]);
      expect(d.model.requests).to.deep.equal([]);
    });

    it('reports a failure of the handler’s permission()', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [revoke('nope')]);
      expect(out).to.deep.equal([{ ok: false, kind: 'assignment.revoke', error: { code: 'not_found', message: 'no assignment nope', field: 'id' } }]);
    });

    it('reports a denied check as forbidden, before the guard', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(bob, [grant('dan')]);
      expect(out).to.have.length(1);
      expect(out[0].ok).to.equal(false);
      expect((out[0] as Extract<AuthzCommandResult, { ok: false }>).error.code).to.equal('forbidden');
      expect(d.store.trace).to.not.include(`guard:${GRANT}`);
      expectNothingAfterCommit(d);
    });

    it('reports a conditional allow as forbidden', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(carol, [grant('dan')]);
      expect((out[0] as Extract<AuthzCommandResult, { ok: false }>).error.code).to.equal('forbidden');
      expect(applies(d)).to.equal(0);
    });

    it('reports a guard refusal', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'guarded')]);
      expect(out).to.deep.equal([
        { ok: true, kind: GRANT, affected: 0 },
        { ok: false, kind: GRANT, error: { code: 'escalation', message: 'role above the actor', field: 'role' } },
      ]);
      expect(d.store.rows.size).to.equal(0);
    });

    it('lets SYSTEM skip the guard', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(SYSTEM, [grant('dan', 'guarded')]);
      expect(out).to.deep.equal([{ ok: true, kind: GRANT, id: 'a1', affected: 1 }]);
      expect(d.store.trace.filter((t) => t.startsWith('guard:'))).to.deep.equal([]);
      expect(adminAudit(d)[0].principal).to.deep.equal({ type: SYSTEM.type, id: SYSTEM.id });
    });

    it('rolls back an applied command when a later one fails', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'clash'), grant('eve')]);
      expect(out).to.deep.equal([
        { ok: true, kind: GRANT, affected: 0 },
        { ok: false, kind: GRANT, error: { code: 'conflict', message: 'the row changed meanwhile' } },
      ]);
      expect(applies(d)).to.equal(2);
      expect(d.store.rows.size).to.equal(0);
      expect(d.backend.version('test')).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('applies nothing when a later command fails before the transaction', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'unknown')]);
      expect(out.map((r) => r.ok)).to.deep.equal([true, false]);
      expect(applies(d)).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('rolls back and rejects on an error that is not an AuthzAdminFailure', async () => {
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, [grant('bob'), grant('dan', 'boom')]));
      expect(err.message).to.equal('driver exploded');
      expect(d.store.rows.size).to.equal(0);
      expect(d.backend.version('test')).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('rejects when the mapped permission is undeclared', async () => {
      adminConfig({ permissions: { 'assignment.grant': 'app:undeclared' } });
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(SYSTEM, [grant('bob')]));
      expect(err).to.be.instanceOf(UnknownPermission);
      expect(applies(d)).to.equal(0);
    });
  });

  describe('dryRun', () => {
    it('validates, guards and applies, returns the results, then rolls back', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan')], { dryRun: true });
      expect(out).to.deep.equal([
        { ok: true, kind: GRANT, id: 'a1', affected: 1 },
        { ok: true, kind: GRANT, id: 'a2', affected: 1 },
      ]);
      expect(d.store.trace.filter((t) => t.startsWith('guard:'))).to.have.length(2);
      expect((d.store.contexts[0] as AdminCallContext).dryRun).to.equal(true);
      expect(d.store.rows.size).to.equal(0);
      expect(d.backend.version('test')).to.equal(0);
      expectNothingAfterCommit(d);
    });

    it('reports failures like a real run', async () => {
      const d = await adminDomain();
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'guarded')], { dryRun: true });
      expect(out.map((r) => r.ok)).to.deep.equal([true, false]);
      expect(out[0]).to.deep.equal({ ok: true, kind: GRANT, affected: 0 });
    });
  });

  describe('idempotency', () => {
    it('returns the first results for the same key without a second effect', async () => {
      const d = await adminDomain();
      const first = await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      const again = await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      expect(again).to.deep.equal(first);
      expect(again).to.not.equal(first);
      expect(applies(d)).to.equal(1);
      expect(d.store.rows.size).to.equal(1);
      expect(d.bus.published).to.have.length(1);
      expect(d.sink.batches).to.have.length(1);
      expect(adminAudit(d)).to.have.length(1);
      expect(d.backend.version('test')).to.equal(1);
    });

    it('keeps keys of different actors apart', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      const other = await d.admin.execute(erin, [grant('dan')], { idempotencyKey: 'k1' });
      expect(other).to.deep.equal([{ ok: true, kind: GRANT, id: 'a2', affected: 1 }]);
      expect(d.store.rows.size).to.equal(2);
    });

    it('forgets a key after 24 hours', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      d.clock.advance(24 * HOUR - 1);
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      expect(d.store.rows.size).to.equal(1);
      d.clock.advance(1);
      const later = await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      expect(later).to.deep.equal([{ ok: true, kind: GRANT, id: 'a2', affected: 1 }]);
      expect(d.store.rows.size).to.equal(2);
    });

    it('never stores a token; a retried link.create answers without it', async () => {
      const d = await adminDomain();
      const link: AuthzCommand = { kind: 'link.create', scope: p1, role: 'viewer' };
      const first = await d.admin.execute(alice, [link], { idempotencyKey: 'k-link' });
      expect(first).to.deep.equal([{ ok: true, kind: 'link.create', id: 'a1', token: 'tok-a1', affected: 1 }]);
      const stored = await d.backend.recall('test', 'user:alice', 'k-link', d.clock.now());
      expect(stored).to.deep.equal([{ ok: true, kind: 'link.create', id: 'a1', affected: 1 }]);
      expect(await d.admin.execute(alice, [link], { idempotencyKey: 'k-link' })).to.deep.equal(stored);
    });

    it('stores nothing for a dry run or a failed batch', async () => {
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1', dryRun: true });
      await d.admin.execute(alice, [grant('bob', 'guarded')], { idempotencyKey: 'k1' });
      expect(await d.backend.recall('test', 'user:alice', 'k1', d.clock.now())).to.equal(undefined);
      const out = await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      // a1 went to the dry run; the guard refused the second batch before it applied anything.
      expect(out).to.deep.equal([{ ok: true, kind: GRANT, id: 'a2', affected: 1 }]);
    });

    it('answers a batch that lost the race with the winner’s results', async () => {
      const d = await adminDomain();
      let open!: () => void;
      d.store.gate = new Promise<void>((r) => (open = r));
      const a = d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'race' });
      const b = d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'race' });
      while (d.store.trace.filter((t) => t.startsWith('permission:')).length < 2) await tick();
      open();
      const [ra, rb] = await Promise.all([a, b]);
      expect(rb).to.deep.equal(ra);
      expect(d.store.rows.size).to.equal(1);
      expect(d.bus.published).to.have.length(1);
      expect(adminAudit(d)).to.have.length(1);
      expect(d.backend.version('test')).to.equal(1);
    });

    it('refuses a key that is not a non-empty string', async () => {
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, [grant('bob')], { idempotencyKey: '' }));
      expect(err).to.be.instanceOf(AuthzAdminFailure);
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect((err as AuthzAdminFailure).field).to.equal('idempotencyKey');
    });
  });

  describe('authz.admin.permissions', () => {
    it('maps by exact kind before family, and by scope type before *', async () => {
      adminConfig({ permissions: { 'assignment.*': 'app:members.manage', 'assignment.grant': { project: 'app:project.share', '*': 'app:any.share' } } });
      const d = await adminDomain();
      await d.admin.execute(SYSTEM, [grant('bob', 'viewer')]);
      d.model.calls.length = 0;
      await d.admin.execute(alice, [grant('dan', 'editor', p1), grant('dan', 'editor', d1), revoke('a1'), { kind: 'link.create', scope: p1, role: 'viewer' }]);
      expect(checked(d)).to.deep.equal(['app:project.share@project', 'app:any.share@doc', 'app:members.manage@project', 'authz:links.manage@project']);
      expect(adminAudit(d).map((e) => e.permission)).to.deep.equal(['app:project.share', 'app:project.share', 'app:any.share', 'app:members.manage', 'authz:links.manage']);
    });

    it('falls back to the family when the exact entry has no match for the type', async () => {
      adminConfig({ permissions: { 'assignment.*': 'app:members.manage', 'assignment.grant': { doc: 'app:any.share' } } });
      const d = await adminDomain();
      await d.admin.execute(alice, [grant('dan', 'editor', p1)]);
      expect(checked(d)).to.deep.equal(['app:members.manage@project']);
    });

    it('rejects a malformed mapping with an AuthzConfigError naming the key', async () => {
      adminConfig({ permissions: { 'assignment.grant': 42 } });
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, [grant('bob')]));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.match(/authz\.admin\.permissions/);
    });
  });

  describe('batch limits', () => {
    it('refuses a batch above authz.admin.maxBatch', async () => {
      adminConfig({ maxBatch: 2 });
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, [grant('a'), grant('b'), grant('c')]));
      expect(err).to.be.instanceOf(AuthzAdminFailure);
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(await d.admin.execute(alice, [grant('a'), grant('b')])).to.have.length(2);
    });

    it('defaults maxBatch to 100', async () => {
      const d = await adminDomain();
      const many = Array.from({ length: 101 }, (_, i) => grant(`u${i}`));
      expect(((await rejection(d.admin.execute(alice, many))) as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(await d.admin.execute(alice, many.slice(1))).to.have.length(100);
    });

    it('refuses commands that are not an array', async () => {
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, grant('bob') as unknown as AuthzCommand[]));
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
    });
  });

  describe('after commit', () => {
    it('logs bus, sink and audit failures without failing the batch', async () => {
      const bus = new FailingBus();
      const audit = new ThrowingAudit();
      const d = await adminDomain('test', { bus, audit, sinks: [new ThrowingSink()] });
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(out).to.deep.equal([{ ok: true, kind: GRANT, id: 'a1', affected: 1 }]);
      expect(d.store.rows.size).to.equal(1);
      expect(bus.published).to.have.length(1);
      expect(audit.of('admin')).to.have.length(1);
      expect(d.sink.events).to.have.length(1);
    });
  });
});
