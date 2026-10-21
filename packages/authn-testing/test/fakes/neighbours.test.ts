import assert from 'node:assert/strict';
import 'mocha';
import type { AuthnEvent, AuthnFacts, Principal } from '@spinajs/authn/contracts';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext, FailedContext } from '@spinajs/hooks';
import { RecordingActionHook, refusingHook } from '@spinajs/hooks/testing';
import * as fakes from '../../src/fakes/index.js';
import { FakeClock, FakeImpersonationGuard, FakeRoleSource, MemoryLinkStore, RecordingEventSink, RecordingPrincipalFactory, RecordingThrottle } from '../../src/fakes/index.js';
import { KitActionHooks } from '../../src/harness/index.js';

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

  it('omits keys it has no value for', async () => {
    const p = await new RecordingPrincipalFactory().principalOf(A, facts(), {});
    assert.deepEqual(Object.keys(p).sort(), ['attributes', 'authenticated', 'authn', 'id', 'source', 'type']);
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
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: false, code: 'forbidden' });
    await g.deny('escalation', A);
    assert.deepEqual(await g.allowed(principal('x'), A), { ok: false, code: 'escalation' });
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

describe('KitActionHooks (the hooks port)', () => {
  const before = (action: string, input: object): BeforeContext<ActionName> =>
    ({
      action,
      input: { ...input },
      bag: new Map(),
      depth: 1,
      refuse(code: string): never {
        throw Object.assign(new Error(code), { refused: code });
      },
    }) as unknown as BeforeContext<ActionName>;
  const after = (action: string, output: unknown): AfterContext<ActionName> => ({ action, input: {}, output, bag: new Map(), depth: 1 }) as unknown as AfterContext<ActionName>;
  const failed = (action: string, error: unknown): FailedContext<ActionName> => ({ action, input: {}, error, bag: new Map(), depth: 1 }) as unknown as FailedContext<ActionName>;

  class Named extends ActionHook {
    constructor(
      readonly actions: readonly ActionPattern[],
      private readonly log: string[],
      private readonly name: string,
      readonly order = 0,
    ) {
      super();
    }

    before(): void {
      this.log.push(`before ${this.name}`);
    }

    after(): void {
      this.log.push(`after ${this.name}`);
    }

    failed(): void {
      this.log.push(`failed ${this.name}`);
    }
  }

  it('matches every action and defines all three phases, so the runner calls it for each', () => {
    const kit = new KitActionHooks();
    assert.deepEqual(kit.actions, ['*']);
    assert.equal(typeof kit.before, 'function');
    assert.equal(typeof kit.after, 'function');
    assert.equal(typeof kit.failed, 'function');
  });

  it('runs the added hooks matching the action by their own patterns: before by order, after and failed in reverse', async () => {
    const log: string[] = [];
    const kit = new KitActionHooks();
    kit.add(new Named(['authn.*'], log, 'a'), new Named(['authn.login'], log, 'b', -1), new Named(['users.*'], log, 'c'));
    await kit.before(before('authn.login', {}));
    await kit.after(after('authn.login', 1));
    await kit.failed(failed('authn.login', new Error('x')));
    await kit.before(before('authn.link', {}));
    assert.deepEqual(log, ['before b', 'before a', 'after a', 'after b', 'failed a', 'failed b', 'before a']);
  });

  it('hands the runner context through, so a refusal and a change of the input reach the runner', async () => {
    const kit = new KitActionHooks();
    const recorder = new RecordingActionHook(['authn.login']);
    kit.add(recorder, refusingHook('authn.login', 'kit-no'));
    const c = before('authn.login', { credentials: 1 });
    await assert.rejects(Promise.resolve(kit.before(c)), (e: { refused?: string }) => e.refused === 'kit-no');
    assert.deepEqual(
      recorder.calls.map((x) => x.phase),
      ['before'],
    );
  });

  it('runs every after hook even when one throws, then rethrows the first error', async () => {
    const log: string[] = [];
    class Throwing extends Named {
      after(): void {
        super.after();
        throw new Error('after failed');
      }
    }
    const kit = new KitActionHooks();
    kit.add(new Named(['*'], log, 'a'), new Throwing(['*'], log, 'b'));
    await assert.rejects(Promise.resolve(kit.after(after('authn.login', 1))), /after failed/);
    assert.deepEqual(log, ['after b', 'after a']);
  });

  it('for an action that is not refusable, runs every before hook past a refusal, then rethrows the first error', async () => {
    const log: string[] = [];
    const kit = new KitActionHooks();
    kit.add(refusingHook('authn.impersonation.stop', 'kit-stay'), new Named(['*'], log, 'a'), refusingHook('authn.login', 'kit-no'));
    await assert.rejects(Promise.resolve(kit.before(before('authn.impersonation.stop', {}))), (e: { refused?: string }) => e.refused === 'kit-stay');
    assert.deepEqual(log, ['before a']);
    log.length = 0;
    kit.clear();
    kit.add(refusingHook('authn.login', 'kit-no'), new Named(['*'], log, 'a'));
    await assert.rejects(Promise.resolve(kit.before(before('authn.login', {}))));
    assert.deepEqual(log, [], 'a refusable action stops at the refusal, as the runner does');
  });

  it('takes the actions that are not refusable from its options', async () => {
    const log: string[] = [];
    const kit = new KitActionHooks({ notRefusable: ['kit.revoke'] });
    kit.add(refusingHook('*', 'kit-stay'), new Named(['*'], log, 'a'));
    await assert.rejects(Promise.resolve(kit.before(before('kit.revoke', {}))));
    assert.deepEqual(log, ['before a']);
  });

  it('clear drops every added hook', async () => {
    const log: string[] = [];
    const kit = new KitActionHooks();
    kit.add(new Named(['*'], log, 'a'));
    kit.clear();
    await kit.before(before('authn.login', {}));
    assert.deepEqual(log, []);
  });

  it('the kit no longer ships RecordingExternalLoginHook', () => {
    assert.equal((fakes as unknown as Record<string, unknown>).RecordingExternalLoginHook, undefined);
  });
});
