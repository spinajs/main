import assert from 'node:assert/strict';
import 'mocha';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { AuthenticationStrategy, AuthnListenerFailed, AuthnService, AuthnThrottle, IdentityStore, MemoryAuthnThrottle, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '@spinajs/authn';
import { FakeIdentityStore, FakeStrategy, MemorySessionIssuer, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

import '../src/index.js';

const OWNER: IdentityRef = { type: 'user', id: 'owner-strict' };
const RIGHT: Credentials = { kind: 'password', login: 'owner-strict@example.test', password: 'right' };
const WRONG: Credentials = { kind: 'password', login: 'owner-strict@example.test', password: 'wrong' };
const ctx = (): AuthnContext => ({ now: new Date('2026-11-16T10:00:00Z'), ip: '192.0.2.47', purpose: 'login' });

/** The app adds one strategy and points the recorder at a rejecting trail; every package config loads as in an application. */
class StrictAppConfiguration extends FrameworkConfiguration {
  constructor() {
    super();
    this.Env = 'test';
  }

  protected onLoad(): unknown {
    return {
      authn: { strategies: [{ name: 'kit-form', service: 'KitForm' }] },
      audit: {
        trails: { strict: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } } },
        authn: { trail: 'strict' },
      },
    };
  }
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

// Every Log of the suite, the ones `@Logger` resolves from the root included; keeps the listener warnings of AuthnAudit.
const warnings: unknown[] = [];
const noop = (): void => undefined;
const logger = { trace: noop, debug: noop, info: noop, error: noop, fatal: noop, warn: (fields: unknown) => void warnings.push(fields), warnOnce: () => false };
const TestLog = (): typeof logger => logger;

describe('a login on a rejecting security trail', function () {
  this.timeout(60_000);

  let child: IContainer | undefined;
  let sessions: MemorySessionIssuer;

  before(() => DI.register(TestLog).as(Log));

  after(() => DI.unregister(Log, TestLog));

  beforeEach(() => {
    MemoryAuditStore.clear();
    warnings.length = 0;
  });

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  async function service(): Promise<AuthnService> {
    const identities = new FakeIdentityStore();
    identities.add({ id: OWNER.id, login: 'owner-strict@example.test' });
    sessions = new MemorySessionIssuer();
    const verify = (c: Credentials): StrategyOutcome => ((c as { password?: unknown }).password === 'right' ? { ok: true, identity: OWNER, method: 'password' } : { ok: false, reason: 'invalid_credentials' });
    const strategy = new FakeStrategy({ name: 'kit-form', kinds: ['password'], interactive: true, keys: () => [{ kind: 'account', value: 'acct-strict' }], verify });

    child = DI.RootContainer.child();
    child.register(StrictAppConfiguration).as(Configuration);
    // Built in the child, so it reads the child's Configuration rather than the root's.
    child.register(MemoryAuthnThrottle).as(AuthnThrottle);
    bind(child, IdentityStore, 'KitIdentityStore', identities);
    bind(child, PrincipalFactory, 'KitPrincipalFactory', new RecordingPrincipalFactory());
    bind(child, SessionIssuer, 'KitSessionIssuer', sessions);
    bind(child, AuthenticationStrategy, 'KitForm', strategy);
    await child.resolve(Configuration);
    const authn: AuthnService = await child.resolve(AuthnService);
    return authn;
  }

  it('records the login and issues the session when the store answers', async () => {
    const authn = await service();

    const result = await authn.authenticate(RIGHT, ctx());

    assert.strictEqual(result.status, 'success');
    assert.strictEqual((await sessions.list(OWNER)).length, 1);
    assert.deepStrictEqual(
      MemoryAuditStore.events('strict').map((e) => [e.action, e.outcome]),
      [
        ['login', 'ok'],
        ['session.issue', 'ok'],
      ],
    );
  });

  it('fails the login with a 503 and leaves no session when the store is down, and records the refusal once it is back', async () => {
    const authn = await service();
    MemoryAuditStore.failNext(2);

    const failure = await authn.authenticate(RIGHT, ctx()).then(
      () => undefined,
      (err: unknown) => err,
    );

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.status, 503);
    assert.strictEqual((await sessions.list(OWNER)).length, 0);
    assert.deepStrictEqual(
      MemoryAuditStore.events('strict').map((e) => [e.action, e.outcome, (e.data as { reason?: unknown }).reason]),
      [['login', 'failed', 'listener_failed']],
    );
  });

  it('a wrong password answers its failure while the store is down, without a 503', async () => {
    const authn = await service();
    MemoryAuditStore.failNext(2);

    const result = await authn.authenticate(WRONG, ctx());

    assert.strictEqual(result.status, 'failure');
    assert.deepStrictEqual(
      warnings.filter((w) => (w as { listener?: unknown }).listener !== undefined),
      [{ listener: 'AuthnAuditRecorder', eventType: 'login', errorClass: 'AuditWriteFailed' }],
    );
    assert.deepStrictEqual(MemoryAuditStore.events('strict'), []);
  });
});
