import assert from 'node:assert/strict';
import 'mocha';
import type { AuthnEvent, AuthnFacts, Principal } from '@spinajs/authn/contracts';
import { FakeClock, FakeImpersonationGuard, FakeRoleSource, MemoryLinkStore, RecordingEventSink, RecordingExternalLoginHook, RecordingPrincipalFactory, RecordingThrottle } from '../../src/fakes/index.js';

const A = { type: 'user', id: 'a' };
const B = { type: 'user', id: 'b' };
const ctx = new FakeClock().ctx();
const facts = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });
const principal = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} });

describe('MemoryLinkStore', () => {
  it('links, finds, lists and unlinks', async () => {
    const s = new MemoryLinkStore();
    const l = await s.link(A, { provider: 'idp', subject: 's1', email: 'a@x.test' });
    assert.match(l.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([l.identity, l.provider, l.subject, l.email], [A, 'idp', 's1', 'a@x.test']);
    assert.ok(l.linkedAt instanceof Date);
    assert.deepEqual(await s.find('idp', 's1'), l);
    assert.equal(await s.find('idp', 's2'), null);
    await s.link(A, { provider: 'other', subject: 's1' });
    await s.link(B, { provider: 'idp', subject: 's9' });
    assert.equal((await s.list(A)).length, 2);
    assert.equal(s.links.length, 3);
    await s.unlink(l.id);
    assert.equal(await s.find('idp', 's1'), null);
    assert.equal(s.links.length, 2);
  });

  it('keeps (provider, subject) unique', async () => {
    const s = new MemoryLinkStore();
    await s.link(A, { provider: 'idp', subject: 's1' });
    await assert.rejects(s.link(B, { provider: 'idp', subject: 's1' }), /duplicate \(provider, subject\)/);
    assert.equal(s.links.length, 1);
  });
});

describe('RecordingEventSink', () => {
  const ev = (type: AuthnEvent['type']): AuthnEvent => ({ type, at: new Date(), outcome: 'success' });

  it('records frozen copies, filters by type and clears', async () => {
    const s = new RecordingEventSink();
    const e = ev('login');
    await s.publish(e);
    await s.publish(ev('logout'));
    assert.equal(s.all().length, 2);
    assert.equal(s.ofType('login').length, 1);
    assert.notEqual(s.all()[0], e);
    assert.deepEqual(s.all()[0], e);
    assert.equal(Object.isFrozen(s.all()[0]), true);
    s.clear();
    assert.deepEqual(s.all(), []);
  });
});

describe('RecordingThrottle', () => {
  const keys = [{ kind: 'account', value: 'a' }];

  it('allows by default and records attempts and successes', async () => {
    const t = new RecordingThrottle();
    assert.deepEqual(await t.attempt(keys, 'login', ctx), { allowed: true });
    await t.succeed(keys, 'login');
    assert.deepEqual(t.attempts, [{ keys, flow: 'login', ctx }]);
    assert.deepEqual(t.succeeds, [{ keys, flow: 'login' }]);
  });

  it('refuses the next attempts as scripted', async () => {
    const t = new RecordingThrottle();
    t.refuse(7, 2);
    t.refuse(3);
    assert.deepEqual(await t.attempt(keys, 'mfa', ctx), { allowed: false, retryAfterSeconds: 7 });
    assert.deepEqual(await t.attempt(keys, 'mfa', ctx), { allowed: false, retryAfterSeconds: 7 });
    assert.deepEqual(await t.attempt(keys, 'mfa', ctx), { allowed: false, retryAfterSeconds: 3 });
    assert.deepEqual(await t.attempt(keys, 'mfa', ctx), { allowed: true });
    assert.equal(t.attempts.length, 4);
  });
});

describe('RecordingPrincipalFactory', () => {
  it('builds a session principal and records the call', async () => {
    const f = new RecordingPrincipalFactory();
    const fa = facts({ sessionHandle: 'h' });
    const p = await f.principalOf(A, fa, { attributes: { profile: 'p' } });
    assert.deepEqual([p.type, p.id, p.authenticated, p.source, p.authn], ['user', 'a', true, 'session', fa]);
    assert.deepEqual(p.attributes, { profile: 'p' });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].id, A);
  });

  it('marks per-request credentials as token and forwards ceiling and delegation', async () => {
    const f = new RecordingPrincipalFactory();
    const behalf = principal('boss');
    const p = await f.principalOf(A, facts(), { ceiling: { roles: ['r'] }, onBehalfOf: behalf, delegation: 'intersect' });
    assert.equal(p.source, 'token');
    assert.deepEqual([p.ceiling, p.onBehalfOf, p.delegation], [{ roles: ['r'] }, behalf, 'intersect']);
  });

  it('lets derived keys win over strategy attributes', async () => {
    const f = new RecordingPrincipalFactory({ derive: (id) => ({ profile: 'derived', who: id.id }) });
    const p = await f.principalOf(A, facts(), { attributes: { profile: 'asserted', extra: 1 } });
    assert.deepEqual(p.attributes, { profile: 'derived', who: 'a', extra: 1 });
  });
});

describe('FakeImpersonationGuard', () => {
  it('allows by default and records calls', async () => {
    const g = new FakeImpersonationGuard();
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: true });
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0].target, A);
  });

  it('denies one target or all targets until allowAll', async () => {
    const g = new FakeImpersonationGuard();
    await g.deny('protected_role', A);
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: false, code: 'protected_role' });
    assert.deepEqual(await g.allowed(principal('x'), B), { ok: true });
    await g.deny('forbidden');
    assert.deepEqual(await g.allowed(principal('x'), B), { ok: false, code: 'forbidden' });
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: false, code: 'protected_role' });
    await g.allowAll();
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: true });
    assert.deepEqual(await g.allowed(principal('x'), B), { ok: true });
  });
});

describe('FakeRoleSource', () => {
  it('returns granted roles by principal id and an empty list otherwise', async () => {
    const r = new FakeRoleSource();
    assert.deepEqual(await r.rolesOf(principal('a')), []);
    await r.grant(A, [{ role: 'kit-editor', requirePassword: false }]);
    assert.deepEqual(await r.rolesOf(principal('a')), [{ role: 'kit-editor', requirePassword: false }]);
    assert.deepEqual(await r.rolesOf(principal('b')), []);
  });
});

describe('RecordingExternalLoginHook', () => {
  it('records calls and fails on request', async () => {
    const h = new RecordingExternalLoginHook();
    const ext = { provider: 'idp', subject: 's' };
    await h.afterLogin(A, ext);
    h.failWith(new Error('boom'));
    await assert.rejects(h.afterLogin(A, ext), /boom/);
    h.failWith(null);
    await h.afterLogin(B, ext);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls[2], { identity: B, external: ext });
  });
});
