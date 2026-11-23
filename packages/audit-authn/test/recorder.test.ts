import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import 'mocha';
import { AuditConfigError, AuditWriteFailed, SECURITY_HASH_PATHS, trailConfig } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { AuthnAudit } from '@spinajs/authn/audit';
import { AuthnEventListener, AuthnListenerFailed } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { AuthnAuditRecorder, logRedaction, securityInput } from '../src/index.js';

const AT = new Date('2026-11-16T10:00:00Z');
const IDENTITY = { type: 'user', id: 'u-1' };

const event = (over: Partial<AuthnEvent> = {}): AuthnEvent => ({
  type: 'login',
  outcome: 'failure',
  at: AT,
  identity: IDENTITY,
  actor: { type: 'user', id: 'admin-1' },
  strategy: 'local',
  reason: 'invalid_credentials',
  ip: '203.0.113.7',
  userAgent: 'curl/8',
  session: 'h-1',
  data: { step: 'password' },
  ...over,
});

// Path forms the core accepts, each on a trail of its own: the recorder decides on the subject with its own copy of the core's matching rule.
const MASK_PATHS = ['data.identity', 'data.identity.id', 'data.identity.type', 'data.identity.*', 'data.identity.0', 'data.*', 'data.*.id', 'data.*.type', 'data.*.kid', 'data.Identity', 'data.0', 'data.ip'];
const PATH_TRAILS = Object.fromEntries(MASK_PATHS.map((path, i) => [`path${i}`, { store: 'MemoryAuditStore', hash: [path] }]));

const TRAILS = {
  // the built-in security trail, with its hash list, on a store the test can read
  security: { store: 'MemoryAuditStore' },
  logins: { store: 'MemoryAuditStore', retry: { attempts: 1 } },
  strict: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
  omitted: { store: 'MemoryAuditStore', omit: ['data.identity'] },
  masked: { store: 'MemoryAuditStore', mask: ['data.identity'] },
  id_hashed: { store: 'MemoryAuditStore', hash: ['data.identity.id'] },
  all_hashed: { store: 'MemoryAuditStore', hash: ['data.*'] },
  ip_hashed: { store: 'MemoryAuditStore', hash: ['data.ip'] },
  plain_log: { store: 'LogAuditStore', hash: [] },
  unstored: { store: 'NoSuchAuditStore' },
  ...PATH_TRAILS,
};

const appWith = (authn?: Record<string, unknown>): Promise<TestApp> => createTestApp({ bootstrap: false, config: { audit: { trails: TRAILS, ...(authn ? { authn } : {}) } } });

describe('securityInput', () => {
  it('maps every field of an AuthnEvent', () => {
    assert.deepStrictEqual(securityInput(event()), {
      kind: 'security',
      action: 'login',
      outcome: 'failed',
      at: AT,
      subject: { type: 'user', id: 'u-1' },
      data: {
        strategy: 'local',
        reason: 'invalid_credentials',
        session: 'h-1',
        ip: '203.0.113.7',
        userAgent: 'curl/8',
        identity: { type: 'user', id: 'u-1' },
        actor: { type: 'user', id: 'admin-1' },
        detail: { step: 'password' },
      },
    });
  });

  it('leaves out what the event does not carry, never writes free text that holds an @, and names no subject when asked not to', () => {
    assert.deepStrictEqual(securityInput({ type: 'logout', outcome: 'success', at: AT, strategy: 'ada@example.test' }), { kind: 'security', action: 'logout', outcome: 'ok', at: AT, data: { strategy: '?' } });
    assert.strictEqual(securityInput(event(), { subject: false }).subject, undefined);
    assert.strictEqual((securityInput(event(), { subject: false }).data as { subjectOmitted?: unknown }).subjectOmitted, true);
    assert.strictEqual((securityInput(event()).data as { subjectOmitted?: unknown }).subjectOmitted, undefined);
    assert.strictEqual((securityInput(event({ userAgent: 'x'.repeat(400) })).data as { userAgent: string }).userAgent.length, 255);
  });

  it('names no subject the trail could not store, and keeps the identity in data', () => {
    const long = event({ identity: { type: 'user', id: 'x'.repeat(256) } });

    assert.strictEqual(securityInput(long).subject, undefined);
    assert.deepStrictEqual((securityInput(long).data as { identity?: unknown }).identity, { type: 'user', id: 'x'.repeat(256) });
    assert.strictEqual((securityInput(long).data as { subjectOmitted?: unknown }).subjectOmitted, true);
  });

  it('for a log, hashes an identity or actor that may be an email and omits what the log never carried', () => {
    assert.deepStrictEqual(logRedaction(event()), { hash: [], omit: ['data.userAgent', 'data.detail'] });
    assert.deepStrictEqual(logRedaction(event({ identity: { type: 'user', id: 'ada@example.test' } })).hash, ['data.identity']);
  });
});

describe('AuthnAuditRecorder on the built-in security trail', function () {
  this.timeout(20000);

  let app: TestApp;
  let recorder: AuthnAuditRecorder;

  before(async () => {
    app = await appWith();
    recorder = await app.resolve(AuthnAuditRecorder);
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  it('is registered as an AuthnEventListener and finds its trail', async () => {
    assert.ok((DI.getRegisteredTypes(AuthnEventListener) ?? []).includes(AuthnAuditRecorder));
    assert.deepStrictEqual(trailConfig('security').hash, SECURITY_HASH_PATHS);
    assert.deepStrictEqual(SECURITY_HASH_PATHS, ['actor', 'onBehalfOf', 'origin', 'data.identity', 'data.actor', 'data.ip', 'data.session']);
    await recorder.ready();
  });

  it('records a security event with every identifier hashed and no subject', async () => {
    await recorder.on(event());
    await recorder.flush();

    const [stored] = MemoryAuditStore.events('security');
    assert.deepStrictEqual([stored.kind, stored.action, stored.outcome, stored.subject], ['security', 'login', 'failed', undefined]);
    assert.strictEqual((stored.data as { subjectOmitted?: unknown }).subjectOmitted, true);
    assert.strictEqual(stored.at.getTime(), AT.getTime());
    const data = stored.data as Record<string, unknown>;
    assert.strictEqual(typeof data.identity, 'string');
    assert.deepStrictEqual([data.strategy, data.reason, data.userAgent], ['local', 'invalid_credentials', 'curl/8']);
    for (const raw of ['u-1', 'admin-1', '203.0.113.7', 'h-1']) assert.ok(!JSON.stringify(stored).includes(raw), raw);
  });

  it('delivered through AuthnAudit, a publish reaches the trail once the listeners are flushed', async () => {
    const audit = AuthnAudit.over([recorder]);

    await audit.publish(event({ type: 'logout', outcome: 'success' }));
    await recorder.flush();

    assert.deepStrictEqual(
      MemoryAuditStore.events('security').map((e) => [e.action, e.outcome]),
      [['logout', 'ok']],
    );
  });
});

describe('AuthnAuditRecorder on audit.authn.trail', function () {
  this.timeout(20000);

  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
  });

  beforeEach(() => MemoryAuditStore.clear());

  it('records into the named trail, with the identity as the subject and identifiers as they are', async () => {
    app = await appWith({ trail: 'logins' });
    const recorder = await app.resolve(AuthnAuditRecorder);

    await recorder.on(event());
    await recorder.flush();

    const [stored] = MemoryAuditStore.events('logins');
    assert.deepStrictEqual(stored.subject, { type: 'user', id: 'u-1' });
    assert.deepStrictEqual((stored.data as { identity?: unknown; ip?: unknown }).identity, { type: 'user', id: 'u-1' });
    assert.strictEqual((stored.data as { ip?: unknown }).ip, '203.0.113.7');
    assert.strictEqual((stored.data as { subjectOmitted?: unknown }).subjectOmitted, undefined);
    assert.deepStrictEqual(MemoryAuditStore.events('security'), []);
  });

  for (const trail of ['omitted', 'masked', 'id_hashed', 'all_hashed']) {
    it(`names no subject on a trail that drops the identity (${trail}), so the id is nowhere in clear`, async () => {
      app = await appWith({ trail });
      const recorder = await app.resolve(AuthnAuditRecorder);

      await recorder.on(event());
      await recorder.flush();

      const [stored] = MemoryAuditStore.events(trail);
      assert.strictEqual(stored.subject, undefined);
      assert.ok(!JSON.stringify(stored).includes('u-1'));
    });
  }

  it('agrees with the core on every path form: a trail whose mask reaches the identity gets no subject', async () => {
    app = await appWith({ trail: 'path0' });
    const configuration = await app.resolve(Configuration);
    const recorder = await app.resolve(AuthnAuditRecorder);
    const reached: string[] = [];

    for (const [i, path] of MASK_PATHS.entries()) {
      configuration.set('audit.authn.trail', `path${i}`);
      await recorder.on(event());
      await recorder.flush();

      const [stored] = MemoryAuditStore.events(`path${i}`);
      if (isDeepStrictEqual((stored.data as { identity?: unknown }).identity, IDENTITY)) continue;
      reached.push(path);
      assert.strictEqual(stored.subject, undefined, `${path} reaches the identity, so the subject must not repeat it`);
    }

    // A change here means the core matches paths differently: check the recorder's rule against it.
    assert.deepStrictEqual(reached, ['data.identity', 'data.identity.id', 'data.identity.type', 'data.identity.*', 'data.*', 'data.*.id', 'data.*.type']);
  });

  it('keeps the subject on a trail whose rules leave the identity alone', async () => {
    app = await appWith({ trail: 'ip_hashed' });
    const recorder = await app.resolve(AuthnAuditRecorder);

    await recorder.on(event());
    await recorder.flush();

    const [stored] = MemoryAuditStore.events('ip_hashed');
    assert.deepStrictEqual(stored.subject, IDENTITY);
    assert.strictEqual((stored.data as { subjectOmitted?: unknown }).subjectOmitted, undefined);
  });

  it('on a log trail with no hash list, still hashes an identity that may be an email and leaves out what the log never carried', async () => {
    app = await appWith({ trail: 'plain_log' });
    const lines: Record<string, unknown>[] = [];
    const capture = (fields: Record<string, unknown>): void => void lines.push(fields);
    app.container.register(() => ({ info: capture, warn: capture })).as(Log);
    const recorder = await app.resolve(AuthnAuditRecorder);

    await recorder.on(event({ identity: { type: 'user', id: 'ada@example.test' } }));
    await recorder.on(event());
    await recorder.flush();

    assert.strictEqual(lines.length, 2);
    const [email, plain] = lines;
    assert.ok(!JSON.stringify(email).includes('ada@example.test'));
    assert.strictEqual(email.subject, undefined);
    assert.strictEqual(plain.subject, 'user:u-1');
    for (const line of lines) {
      const data = JSON.parse(String(line.data)) as Record<string, unknown>;
      assert.deepStrictEqual([data.userAgent, data.detail], [undefined, undefined]);
    }
  });

  it('ready() refuses a trail whose store is not registered, so the boot fails and not every login', async () => {
    app = await appWith({ trail: 'unstored' });
    const recorder = await app.resolve(AuthnAuditRecorder);

    await assert.rejects(Promise.resolve().then(() => recorder.ready()), AuditConfigError);
  });

  it('a continue trail never blocks: with its store down the event is lost, logged by the audit service, and the publish resolves', async () => {
    app = await appWith({ trail: 'logins' });
    const lost: unknown[] = [];
    const logger = { warn: () => undefined, error: (fields: { trail?: unknown }) => void lost.push(fields.trail) };
    app.container.register(() => logger).as(Log);
    const recorder = await app.resolve(AuthnAuditRecorder);
    MemoryAuditStore.failNext(1);

    assert.strictEqual(recorder.blocking, false);
    await AuthnAudit.over([recorder]).publish(event({ outcome: 'success' }));
    await recorder.flush();

    assert.deepStrictEqual(MemoryAuditStore.events('logins'), []);
    assert.deepStrictEqual(lost, ['logins']);
  });

  it('ready() refuses a trail that is not configured, and a success event is then stopped, not thrown through', async () => {
    app = await appWith({ trail: 'nope' });
    const recorder = await app.resolve(AuthnAuditRecorder);

    await assert.rejects(Promise.resolve().then(() => recorder.ready()), AuditConfigError);
    assert.strictEqual(recorder.blocking, true);
    const failure = await AuthnAudit.over([recorder])
      .publish(event({ outcome: 'success' }))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    assert.ok(failure instanceof AuthnListenerFailed);
    assert.ok(failure.inner instanceof AuditConfigError);
  });
});

describe('AuthnAuditRecorder on a rejecting trail', function () {
  this.timeout(20000);

  let app: TestApp;
  let recorder: AuthnAuditRecorder;

  before(async () => {
    app = await appWith({ trail: 'strict' });
    recorder = await app.resolve(AuthnAuditRecorder);
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  const failureOf = (work: Promise<unknown>): Promise<unknown> =>
    work.then(
      () => undefined,
      (err: unknown) => err,
    );

  it('is blocking, and records a success event before the publish resolves', async () => {
    assert.strictEqual(recorder.blocking, true);

    await AuthnAudit.over([recorder]).publish(event({ outcome: 'success' }));

    assert.deepStrictEqual(
      MemoryAuditStore.events('strict').map((e) => [e.action, e.outcome]),
      [['login', 'ok']],
    );
  });

  it('with its store down, stops a success event: the publish rejects with what the store said and nothing is recorded', async () => {
    MemoryAuditStore.failNext(2);

    const failure = await failureOf(AuthnAudit.over([recorder]).publish(event({ outcome: 'success' })));

    assert.ok(failure instanceof AuthnListenerFailed);
    assert.strictEqual(failure.status, 503);
    assert.ok(failure.inner instanceof AuditWriteFailed);
    assert.deepStrictEqual(MemoryAuditStore.events('strict'), []);
  });

  it('retries as its trail says before it stops anything: a second try that succeeds records the event', async () => {
    MemoryAuditStore.failNext(1);

    await AuthnAudit.over([recorder]).publish(event({ outcome: 'success' }));

    assert.deepStrictEqual(
      MemoryAuditStore.events('strict').map((e) => e.action),
      ['login'],
    );
  });

  it('records a failed login when it can and never stops it when it cannot', async () => {
    const warnings: unknown[][] = [];
    MemoryAuditStore.failNext(2);

    await AuthnAudit.over([recorder], { log: { warn: (...args: unknown[]) => void warnings.push(args) } }).publish(event());
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(MemoryAuditStore.events('strict'), []);

    await AuthnAudit.over([recorder]).publish(event());
    assert.deepStrictEqual(
      MemoryAuditStore.events('strict').map((e) => e.outcome),
      ['failed'],
    );
  });
});
