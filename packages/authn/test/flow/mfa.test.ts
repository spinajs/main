import assert from 'node:assert/strict';
import 'mocha';
import { FakeMfaStep, fakeHash } from '@spinajs/authn-testing';

import { DefaultMfaPolicy, MfaStep, MfaStepRegistry, RoleSource } from '../../src/index.js';
import type { IdentityRef, Principal } from '../../src/index.js';
import { KIT_MFA_STEP, bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const PASSWORD = { method: 'password', strategy: 'local' };

class Roles extends RoleSource {
  readonly asked: Principal[] = [];
  constructor(private readonly roles: readonly string[] | Error) {
    super();
  }
  async rolesOf(p: Principal): Promise<readonly { role: string; requirePassword: boolean }[]> {
    this.asked.push(p);
    if (this.roles instanceof Error) throw this.roles;
    return this.roles.map((role) => ({ role, requirePassword: false }));
  }
}

describe('MFA steps and DefaultMfaPolicy', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  /** The kit step 'fake' plus `extra`, listed in that order unless `steps` gives the list. */
  async function boot(opts: { extra?: MfaStep[]; steps?: unknown; mfa?: Record<string, unknown>; register?: CoreOptions['register'] } = {}): Promise<CoreParts> {
    const extra = opts.extra ?? [];
    const steps = 'steps' in opts ? opts.steps : [{ name: 'fake', service: KIT_MFA_STEP }, ...extra.map((s) => ({ name: s.name, service: `Step_${s.name}` }))];
    parts = await buildCore(
      {},
      {
        raw: { authn: { mfa: { ...(opts.mfa ?? {}), steps } } },
        register: (c) => {
          extra.forEach((s) => bind(c, MfaStep, `Step_${s.name}`, s));
          opts.register?.(c);
        },
      },
    );
    return parts;
  }

  async function bootFails(opts: Parameters<typeof boot>[0], ...words: string[]): Promise<void> {
    let error: unknown;
    try {
      await boot(opts);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Error, 'the boot fails');
    for (const w of words) assert.ok(error.message.includes(w), `${error.message} names ${w}`);
  }

  const policyOf = async (p: CoreParts): Promise<DefaultMfaPolicy> => p.child.resolve(DefaultMfaPolicy);

  describe('MfaStepRegistry', () => {
    it('lists the steps of authn.mfa.steps in list order', async () => {
      const second = new FakeMfaStep({ name: 'second' });
      const p = await boot({ extra: [second] });
      const registry = await p.child.resolve(MfaStepRegistry);
      assert.deepStrictEqual(
        registry.steps().map((s) => s.name),
        ['fake', 'second'],
      );
      assert.strictEqual(registry.get('second'), second);
      assert.strictEqual(registry.get('recovery'), undefined);
      assert.strictEqual(registry.get('nope'), undefined);
    });

    it('is empty when authn.mfa.steps is unset', async () => {
      await boot({ steps: undefined });
      assert.deepStrictEqual((await parts!.child.resolve(MfaStepRegistry)).steps(), []);
    });

    it('fails boot when the list repeats an entry', async () => {
      await bootFails(
        {
          steps: [
            { name: 'fake', service: KIT_MFA_STEP },
            { name: 'fake', service: KIT_MFA_STEP },
          ],
        },
        'authn.mfa.steps',
      );
    });

    it('fails boot on an unknown service, a name mismatch, a reserved or duplicate name and a non-step', async () => {
      await bootFails({ steps: [{ name: 'totp', service: 'TotpMfaStep' }] }, 'authn.mfa.steps', 'TotpMfaStep');
      await bootFails({ steps: [{ name: 'other', service: KIT_MFA_STEP }] }, 'authn.mfa.steps', '"other"', '"fake"');
      await bootFails({ steps: [{ name: 'recovery', service: KIT_MFA_STEP }] }, 'authn.mfa.steps.0.name');
      const second = new FakeMfaStep({ name: 'second' });
      await bootFails(
        {
          extra: [second],
          steps: [
            { name: 'fake', service: KIT_MFA_STEP },
            { name: 'fake', service: 'Step_second' },
          ],
        },
        'authn.mfa.steps',
      );
      await bootFails({ steps: [{ name: 'x', service: 'NotAStep' }], register: (c) => bind(c, MfaStep, 'NotAStep', { name: 'x' }) }, 'NotAStep', 'not an MfaStep');
      await bootFails({ steps: 'totp' }, 'authn.mfa.steps');
      await bootFails({ steps: [{ name: '', service: KIT_MFA_STEP }] }, 'authn.mfa.steps.0.name');
    });
  });

  describe('DefaultMfaPolicy', () => {
    it('requires the enrolled steps, in list order, for a password login', async () => {
      const second = new FakeMfaStep({ name: 'second' });
      const p = await boot({ extra: [second] });
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), []);
      second.enrol(ALICE);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['second']);
      p.step.enrol(ALICE);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['fake', 'second']);
    });

    it('requires nothing for logins other than password, even when enrolled or forced (D13)', async () => {
      const p = await boot({ mfa: { policy: { force: true } } });
      p.step.enrol(ALICE);
      const policy = await policyOf(p);
      for (const method of ['oidc', 'key-challenge', 'token']) assert.deepStrictEqual(await policy.required(ALICE, { method, strategy: 's' }), [], method);
    });

    it('under force requires the first step when none is enrolled', async () => {
      const second = new FakeMfaStep({ name: 'second' });
      const p = await boot({ extra: [second], mfa: { policy: { force: true } } });
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['fake']);
      second.enrol(ALICE);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['second']);
    });

    it('fails boot when force has no step to require', async () => {
      await bootFails({ steps: [], mfa: { policy: { force: true } } }, 'authn.mfa.policy.force', 'authn.mfa.steps');
    });

    it('fails boot on malformed policy options', async () => {
      await bootFails({ mfa: { policy: { force: 'yes' } } }, 'authn.mfa.policy.force');
      await bootFails({ mfa: { policy: { forceForRoles: 'admin' } } }, 'authn.mfa.policy.forceForRoles');
    });

    it('fails boot when forceForRoles is set and no RoleSource is registered', async () => {
      await bootFails({ mfa: { policy: { forceForRoles: ['admin'] } } }, 'forceForRoles', 'RoleSource');
    });

    it('under forceForRoles requires the first step for holders of a listed role', async () => {
      const admin = new Roles(['admin']);
      let p = await boot({ mfa: { policy: { forceForRoles: ['admin'] } }, register: (c) => bind(c, RoleSource, 'KitRoles', admin) });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), ['fake']);
      assert.deepStrictEqual(
        admin.asked.map((x) => [x.type, x.id]),
        [['user', 'alice']],
      );
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, { method: 'oidc', strategy: 'o' }), [], 'password logins only (D13)');
      await p.dispose();
      p = await boot({ mfa: { policy: { forceForRoles: ['admin'] } }, register: (c) => bind(c, RoleSource, 'KitRoles', new Roles(['editor'])) });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), []);
      p.step.enrol(ALICE);
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), ['fake'], 'enrolled steps still count');
    });

    it('requires the first step when the RoleSource fails', async () => {
      const p = await boot({ mfa: { policy: { forceForRoles: ['admin'] } }, register: (c) => bind(c, RoleSource, 'KitRoles', new Roles(new Error('down'))) });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), ['fake']);
    });

    it('drives the login flow: a forced login gets a pending session', async () => {
      const p = await boot({ mfa: { policy: { force: true } } });
      const id = p.identities.add({ login: 'alice@example.test' });
      await p.passwords.set(id, fakeHash('Alice-Pass-1234'));
      const r = await p.service.authenticate({ kind: 'password', login: 'alice@example.test', password: 'Alice-Pass-1234' }, { now: new Date(), purpose: 'login' });
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
    });
  });
});
