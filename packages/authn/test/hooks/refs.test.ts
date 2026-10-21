import assert from 'node:assert/strict';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';

import { AccountLinkService, AuthnImpersonationService, MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, AuthnFacts, Credentials, ExternalSubject, IdentityRef, SessionHandle, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const OTHER_IP = '203.0.113.9';
const T0 = new Date('2026-10-03T10:00:00Z');
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const BOB = { login: 'bob@example.test', password: 'Bob-Pass-2345x' };

class KeyThrottle extends MemoryAuthnThrottle {
  readonly keys: string[] = [];

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.keys.push(...keys.map((k) => `${k.kind}=${k.value}`));
    return super.attempt(keys, flow, ctx);
  }
}

/**
 * Writes into the objects its before hook gets, as a careless hook might, and records whether each write landed.
 * The action must not see any of it: the values under keys it does not declare mutable are the hook's own frozen copies.
 */
class InPlaceHook extends ActionHook {
  readonly landed: string[] = [];

  constructor(
    readonly actions: readonly ActionPattern[],
    private readonly write: (input: Record<string, Record<string, unknown>>) => void,
  ) {
    super();
  }

  before(ctx: BeforeContext<ActionName>): void {
    try {
      this.write(ctx.input as unknown as Record<string, Record<string, unknown>>);
      this.landed.push(ctx.action);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }
}

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

describe('action hooks get copies: a write in place never reaches the action', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: KeyThrottle | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(hooks: readonly ActionHook[], opts: CoreOptions = {}): Promise<CoreParts> {
    parts = await buildCore({}, { throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new KeyThrottle(), k)), hooks, ...opts, raw: { authn: { freshAuth: { maxAgeSeconds: 300 } } } });
    return parts;
  }

  const seed = async (p: CoreParts, u: { login: string; password: string } = ALICE): Promise<IdentityRef> => {
    const id = p.identities.add({ login: u.login, email: u.login });
    await p.passwords.set(id, fakeHash(u.password));
    return id;
  };

  const login = async (p: CoreParts): Promise<Extract<AuthenticationResult, { status: 'success' }>> => {
    const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    return r;
  };

  it('authn.login: the ctx a hook changes in place is not the one the throttle and the audit read', async () => {
    const hook = new InPlaceHook(['authn.login'], (i) => {
      i.ctx.ip = OTHER_IP;
    });
    const p = await boot([hook]);
    await seed(p);
    await login(p);
    assert.deepStrictEqual(hook.landed, [], 'the write fails on a frozen copy');
    assert.ok(!throttle!.keys.some((k) => k.includes(OTHER_IP)), JSON.stringify(throttle!.keys));
    for (const e of p.events.all()) assert.strictEqual(e.ip, IP);
  });

  it('authn.login.identified: a changed identity.id does not decide who gets the session', async () => {
    const hook = new InPlaceHook(['authn.login.identified'], (i) => {
      i.identity.id = 'bob-1';
    });
    const p = await boot([hook]);
    p.identities.add({ id: 'bob-1', login: BOB.login });
    const a = await seed(p);
    const r = await login(p);
    assert.deepStrictEqual(hook.landed, []);
    assert.deepStrictEqual(r.identity, a);
    assert.deepStrictEqual((await p.sessions.restore(r.session!.id))?.identity, a);
  });

  it('authn.login.identified: a changed external.sid does not reach the session facts', async () => {
    const subject: ExternalSubject = { provider: 'kit-idp', subject: 'sub-1', sid: 'idp-1' };
    const hook = new InPlaceHook(['authn.login.identified'], (i) => {
      i.external.sid = 'idp-other';
    });
    const p = await boot([hook]);
    const a = await seed(p);
    await p.links.link(a, subject);
    p.externalSubjects.set('sub-1', subject);
    const r = await p.service.authenticate({ kind: 'external', provider: 'kit-idp', payload: { subject: 'sub-1' } }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.deepStrictEqual(hook.landed, []);
    assert.strictEqual((await p.sessions.restore((r as { session: SessionHandle }).session.id))?.facts.external?.sid, 'idp-1');
  });

  it('authn.mfa.verify: a changed pending.id does not decide which session is elevated', async () => {
    const hook = new InPlaceHook(['authn.mfa.verify'], (i) => {
      i.pending.id = 'another-session';
    });
    const p = await boot([hook]);
    const a = await seed(p);
    p.step.enrol(a);
    const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
    assert.strictEqual(r.status, 'mfa_required');
    const pending = (r as { pending: SessionHandle }).pending;
    const done = await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx());
    assert.strictEqual(done.status, 'success', JSON.stringify(done));
    assert.deepStrictEqual(hook.landed, []);
    assert.strictEqual(pending.id, (r as { pending: SessionHandle }).pending.id, "the caller's handle is untouched");
  });

  it('authn.reauth: a changed credentials.password is not what the strategy verifies', async () => {
    const hook = new InPlaceHook(['authn.reauth'], (i) => {
      i.credentials.password = ALICE.password;
    });
    const p = await boot([hook]);
    await seed(p);
    const { session } = await login(p);
    assert.strictEqual(await p.service.reauthenticate(session!, pw(ALICE.login, 'Wrong-Pass-9876'), ctx({ purpose: 'reauth', session })), false);
    assert.deepStrictEqual(hook.landed, []);
  });

  it('authn.impersonation.start: a changed target.id does not decide whom the actor becomes', async () => {
    const hook = new InPlaceHook(['authn.impersonation.start'], (i) => {
      i.target.id = 'carol-1';
    });
    const p = await boot([hook]);
    const a = await seed(p);
    const b = await seed(p, BOB);
    p.identities.add({ id: 'carol-1', login: 'carol@example.test' });
    const admin: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: T0 };
    const session = await p.sessions.issue(a, admin);
    const svc = await p.child.resolve(AuthnImpersonationService);
    const r = await svc.start(session, b, ctx({ now: new Date(T0.getTime() + 10_000) }));
    assert.ok(r.ok, 'impersonation starts');
    assert.deepStrictEqual(hook.landed, []);
    assert.strictEqual((await p.sessions.restore(r.session.id))?.identity.id, b.id);
    assert.ok(p.events.ofType('impersonation.start').every((e) => e.identity?.id === b.id));
  });

  it('authn.link: a changed external.subject is not what gets linked', async () => {
    const hook = new InPlaceHook(['authn.link'], (i) => {
      i.external.subject = 'g-stolen';
    });
    const p = await boot([hook]);
    await seed(p);
    const { session } = await login(p);
    const svc = await p.child.resolve(AccountLinkService);
    const r = await svc.link(session!, { provider: 'kit-g', subject: 'g-alice' }, ctx({ purpose: 'link', session }));
    assert.ok(r.ok);
    assert.deepStrictEqual(hook.landed, []);
    assert.strictEqual(r.link.subject, 'g-alice');
    assert.strictEqual(await p.links.find('kit-g', 'g-stolen'), null);
  });

  it('a hook that does not catch the failed write fails the action closed, as any failing hook does', async () => {
    class Writer extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['authn.login.identified'];
      before(c: BeforeContext<ActionName>): void {
        (c.input as unknown as { identity: IdentityRef & { id: string } }).identity.id = 'bob-1';
      }
    }
    const p = await boot([new Writer()]);
    await seed(p);
    assert.deepStrictEqual(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), { status: 'failure', reason: 'invalid_credentials' });
    assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
    assert.ok(p.events.ofType('login').some((e) => e.reason === 'hook_error'));
  });
});
