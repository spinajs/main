import assert from 'node:assert/strict';
import 'mocha';

import { DefaultMfaPolicy, MfaEnrolments, MfaStepNotListed } from '../../src/index.js';
import type { AuthenticationResult, IdentityRef } from '../../src/index.js';
import { bind, buildCore, useHarnessLog, violationPaths } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const PASSWORD = { method: 'password', strategy: 'local' };
const OIDC = { method: 'oidc', strategy: 'oidc:kit' };
const OTHER_METHODS = ['key-challenge', 'token', 'jws'];

class Enrolments extends MfaEnrolments {
  constructor(private readonly byId: Readonly<Record<string, readonly string[]>>) {
    super();
  }
  async stepsOf(id: IdentityRef): Promise<readonly string[]> {
    return this.byId[id.id] ?? [];
  }
  async stepNames(): Promise<readonly string[]> {
    return [...new Set(Object.values(this.byId).flat())];
  }
}

describe('DefaultMfaPolicy by login method (SEC-7)', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(policy: Record<string, unknown> = {}, register?: CoreOptions['register']): Promise<CoreParts> {
    parts = await buildCore({}, { raw: { authn: { mfa: { policy } } }, register });
    return parts;
  }

  const policyOf = (p: CoreParts): Promise<DefaultMfaPolicy> => p.child.resolve(DefaultMfaPolicy);

  async function aliceWithOidc(p: CoreParts, enrolled: boolean): Promise<{ id: IdentityRef; login: () => Promise<AuthenticationResult> }> {
    const id = p.identities.add({ login: 'alice@example.test' });
    const subject = { provider: 'kit-idp', subject: 'alice-sub' };
    await p.links.link(id, subject);
    p.externalSubjects.set(subject.subject, subject);
    if (enrolled) p.step.enrol(id);
    return { id, login: () => p.service.authenticate({ kind: 'external', provider: 'kit-idp', payload: { subject: subject.subject } }, { now: new Date(), purpose: 'login' }) };
  }

  describe('the default', () => {
    it('lists password only', async () => {
      const p = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.mfa.policy.methods'), ['password']);
    });

    it('logs in an OIDC identity enrolled in TOTP without a second factor, at aal1', async () => {
      const p = await boot();
      const { login } = await aliceWithOidc(p, true);
      const r = await login();
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.deepStrictEqual(r.status === 'success' && { method: r.facts.method, assurance: r.facts.assurance, mfa: r.facts.mfa }, { method: 'oidc', assurance: 'aal1', mfa: [] });
    });

    it('requires nothing of key, token and OIDC logins, enrolled or forced', async () => {
      const p = await boot({ force: true });
      const { id } = await aliceWithOidc(p, true);
      const policy = await policyOf(p);
      for (const method of ['oidc', ...OTHER_METHODS]) assert.deepStrictEqual(await policy.required(id, { method, strategy: 's' }), [], method);
      assert.deepStrictEqual(await policy.required(id, PASSWORD), ['fake']);
    });
  });

  describe('methods listing oidc', () => {
    const METHODS = { methods: ['password', 'oidc'] };

    it('turns an OIDC login of an enrolled identity into a pending session', async () => {
      const p = await boot(METHODS);
      const { login } = await aliceWithOidc(p, true);
      const r = await login();
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      assert.deepStrictEqual(r.status === 'mfa_required' && [...r.steps], ['fake']);
      assert.ok(!p.events.all().some((e) => e.type === 'login' && e.outcome === 'success'));
    });

    it('asks for the step by method and leaves the unlisted methods alone', async () => {
      const p = await boot(METHODS);
      const { id } = await aliceWithOidc(p, true);
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(id, OIDC), ['fake']);
      assert.deepStrictEqual(await policy.required(id, PASSWORD), ['fake']);
      for (const method of OTHER_METHODS) assert.deepStrictEqual(await policy.required(id, { method, strategy: 's' }), [], method);
    });

    it('leaves an identity without an enrolment alone', async () => {
      const p = await boot(METHODS);
      const { login } = await aliceWithOidc(p, false);
      assert.strictEqual((await login()).status, 'success');
    });

    it('under force requires the first step of an unenrolled OIDC identity, so the pending session can enrol', async () => {
      const p = await boot({ ...METHODS, force: true });
      const { login } = await aliceWithOidc(p, false);
      const r = await login();
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      assert.deepStrictEqual(r.status === 'mfa_required' && [...r.steps], ['fake']);
    });

    it('refuses an OIDC login of an identity enrolled in a step the list leaves out', async () => {
      const p = await boot(METHODS, (c) => bind(c, MfaEnrolments, 'KitEnrolments', new Enrolments({ alice: ['webauthn'] })));
      const policy = await policyOf(p);
      const alice: IdentityRef = { type: 'user', id: 'alice' };
      await assert.rejects(policy.required(alice, OIDC), MfaStepNotListed);
    });

    it('does not look at stored enrolments of an OIDC login under the default', async () => {
      const p = await boot({}, (c) => bind(c, MfaEnrolments, 'KitEnrolments', new Enrolments({ alice: ['webauthn'] })));
      assert.deepStrictEqual(await (await policyOf(p)).required({ type: 'user', id: 'alice' }, OIDC), []);
    });
  });

  describe('methods leaving password out', () => {
    it('exempts password logins and asks the listed methods', async () => {
      const p = await boot({ methods: ['oidc'] });
      const { id } = await aliceWithOidc(p, true);
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(id, PASSWORD), []);
      assert.deepStrictEqual(await policy.required(id, OIDC), ['fake']);
    });
  });

  it('reads methods when it decides, not at boot', async () => {
    const p = await boot();
    const { id } = await aliceWithOidc(p, true);
    const policy = await policyOf(p);
    assert.deepStrictEqual(await policy.required(id, OIDC), []);
    p.configuration.set('authn.mfa.policy.methods', ['password', 'oidc']);
    assert.deepStrictEqual(await policy.required(id, OIDC), ['fake']);
  });

  it('refuses malformed methods, naming the path of each', async () => {
    const cases: [unknown, string][] = [
      ['oidc', 'authn.mfa.policy.methods'],
      [[''], 'authn.mfa.policy.methods.0'],
    ];
    for (const [methods, path] of cases) {
      const paths = await violationPaths(boot({ methods }));
      assert.ok(paths.includes(path), `${JSON.stringify(methods)}: ${paths.join(', ')}`);
    }
  });
});
