import assert from 'node:assert/strict';
import 'mocha';
import { FakeMfaStep, fakeHash } from '@spinajs/authn-testing';

import { DefaultMfaPolicy, MfaEnrolmentMismatch, MfaEnrolments, MfaStep, MfaStepNotListed, MfaStepRegistry, RoleSource } from '../../src/index.js';
import type { IdentityRef, Principal } from '../../src/index.js';
import { KIT_MFA_STEP, bind, buildCore, invalidOf, useHarnessLog, violationPaths } from '../behaviour/harness.js';
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

/** Confirmed steps by identity id, as a store would report them. */
class Enrolments extends MfaEnrolments {
  readonly asked: IdentityRef[] = [];
  constructor(private readonly byId: Readonly<Record<string, readonly string[]>> | Error) {
    super();
  }
  async stepsOf(id: IdentityRef): Promise<readonly string[]> {
    this.asked.push(id);
    if (this.byId instanceof Error) throw this.byId;
    return this.byId[id.id] ?? [];
  }
  async stepNames(): Promise<readonly string[]> {
    if (this.byId instanceof Error) throw this.byId;
    return [...new Set(Object.values(this.byId).flat())];
  }
}

const BOB: IdentityRef = { type: 'user', id: 'bob' };

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

    it('is empty when authn.mfa.steps is unset, through the schema default', async () => {
      await boot({ steps: undefined });
      assert.deepStrictEqual((await parts!.child.resolve(MfaStepRegistry)).steps(), []);
    });

    it('fails boot on an unknown service, a name mismatch and a non-step', async () => {
      await bootFails({ steps: [{ name: 'totp', service: 'TotpMfaStep' }] }, 'authn.mfa.steps', 'TotpMfaStep');
      await bootFails({ steps: [{ name: 'other', service: KIT_MFA_STEP }] }, 'authn.mfa.steps', '"other"', '"fake"');
      await bootFails({ steps: [{ name: 'x', service: 'NotAStep' }], register: (c) => bind(c, MfaStep, 'NotAStep', { name: 'x' }) }, 'NotAStep', 'not an MfaStep');
    });

    const refused: [string, unknown, string][] = [
      ['the reserved name recovery', [{ name: 'recovery', service: KIT_MFA_STEP }], 'authn.mfa.steps.0.name'],
      ['a name listed twice', [{ name: 'fake', service: KIT_MFA_STEP }, { name: 'fake', service: 'Step_second' }], 'authn.mfa.steps'],
      ['an identical entry listed twice', [{ name: 'fake', service: KIT_MFA_STEP }, { name: 'fake', service: KIT_MFA_STEP }], 'authn.mfa.steps'],
      ['a string instead of a list', 'totp', 'authn.mfa.steps'],
      ['null instead of a list', null, 'authn.mfa.steps'],
      ['an empty name', [{ name: '', service: KIT_MFA_STEP }], 'authn.mfa.steps.0.name'],
    ];
    for (const [what, steps, path] of refused) {
      it(`refuses ${what}, naming ${path}`, async () => {
        const paths = await violationPaths(boot({ steps, extra: [new FakeMfaStep({ name: 'second' })] }));
        assert.ok(paths.includes(path), paths.join(', '));
      });
    }

    it('refuses a name listed twice by the unique-name rule, not by another rule at the same path', async () => {
      const steps = [
        { name: 'fake', service: KIT_MFA_STEP },
        { name: 'fake', service: 'Step_second' },
      ];
      const { violations } = await invalidOf(boot({ steps, extra: [new FakeMfaStep({ name: 'second' })] }));
      assert.deepStrictEqual(
        violations.map((v) => v.path),
        ['authn.mfa.steps'],
      );
      assert.match(violations[0].message, /uniqueItemProperties/);
    });

    it('lists an identical entry twice when it comes past the schema (Configuration.set): only the schema refuses repeats', async () => {
      const p = await boot();
      p.configuration.set('authn.mfa.steps', [
        { name: 'fake', service: KIT_MFA_STEP },
        { name: 'fake', service: KIT_MFA_STEP },
      ]);
      const fresh = p.child.child();
      try {
        const registry = await fresh.resolve(MfaStepRegistry);
        assert.deepStrictEqual(
          registry.steps().map((s) => s.name),
          ['fake', 'fake'],
        );
      } finally {
        await fresh.dispose();
      }
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

    it('refuses force with no step to require, naming authn.mfa.steps', async () => {
      const paths = await violationPaths(boot({ steps: [], mfa: { policy: { force: true } } }));
      assert.ok(paths.includes('authn.mfa.steps'), paths.join(', '));
    });

    it('refuses forceForRoles with no step to require, naming authn.mfa.steps', async () => {
      const paths = await violationPaths(boot({ steps: [], mfa: { policy: { forceForRoles: ['admin'] } } }));
      assert.ok(paths.includes('authn.mfa.steps'), paths.join(', '));
    });

    it('accepts an empty step list while nothing is forced', async () => {
      const p = await boot({ steps: [] });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), []);
    });

    it('refuses malformed policy options, naming the path of each', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ force: 'yes' }, 'authn.mfa.policy.force'],
        [{ forceForRoles: 'admin' }, 'authn.mfa.policy.forceForRoles'],
        [{ forceForRoles: [''] }, 'authn.mfa.policy.forceForRoles.0'],
        [{ service: '' }, 'authn.mfa.policy.service'],
      ];
      for (const [policy, path] of cases) {
        const paths = await violationPaths(boot({ mfa: { policy } }));
        assert.ok(paths.includes(path), `${JSON.stringify(policy)}: ${paths.join(', ')}`);
      }
    });

    it('takes the policy defaults from the schema', async () => {
      const p = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.mfa.policy'), { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] });
      const policy = await policyOf(p);
      assert.strictEqual(policy.force, false);
      assert.deepStrictEqual(policy.forceForRoles, []);
    });

    it('reads force when it decides, not at boot', async () => {
      const p = await boot();
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), []);
      p.configuration.set('authn.mfa.policy.force', true);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['fake']);
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

    describe('enrolments in steps authn.mfa.steps does not list (a 2.x migration that lists no step)', () => {
      const withEnrolments =
        (...sources: Enrolments[]) =>
        (c: Parameters<NonNullable<CoreOptions['register']>>[0]): void =>
          sources.forEach((s, i) => bind(c, MfaEnrolments, `KitEnrolments${i}`, s));

      async function refusedWith(p: Promise<readonly string[]>, steps: string[]): Promise<void> {
        await assert.rejects(p, (e: unknown) => {
          assert.ok(e instanceof MfaStepNotListed, String(e));
          assert.deepStrictEqual([...e.steps], steps);
          return true;
        });
      }

      it('refuses a password login of an identity enrolled only in unlisted steps, naming them', async () => {
        const p = await boot({ steps: [], register: withEnrolments(new Enrolments({ alice: ['totp', 'webauthn'] })) });
        const policy = await policyOf(p);
        await refusedWith(policy.required(ALICE, PASSWORD), ['totp', 'webauthn']);
        assert.deepStrictEqual(await policy.required(BOB, PASSWORD), [], 'an identity without an enrolment');
      });

      it('refuses when some steps are listed but the identity is enrolled in none of them', async () => {
        const p = await boot({ register: withEnrolments(new Enrolments({ alice: ['totp'], bob: ['fake'] })) });
        const policy = await policyOf(p);
        await refusedWith(policy.required(ALICE, PASSWORD), ['totp']);
        await assert.rejects(policy.required(BOB, PASSWORD), MfaEnrolmentMismatch, 'a row of a listed step that step does not see');
      });

      it('refuses when a source reports a listed step that step says the identity is not enrolled in (a store mismatch)', async () => {
        const p = await boot({ register: withEnrolments(new Enrolments({ bob: ['fake'] })) });
        const policy = await policyOf(p);
        await assert.rejects(policy.required(BOB, PASSWORD), (e: unknown) => {
          assert.ok(e instanceof MfaEnrolmentMismatch, String(e));
          assert.deepStrictEqual([...e.steps], ['fake']);
          return true;
        });
        assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), [], 'an identity without an enrolment');
      });

      it('names the unlisted steps when a source reports both an unlisted and a mismatched listed step', async () => {
        const p = await boot({ register: withEnrolments(new Enrolments({ alice: ['fake', 'totp'] })) });
        await refusedWith((await policyOf(p)).required(ALICE, PASSWORD), ['totp']);
      });

      it('refuses under force and forceForRoles instead of requiring the first step', async () => {
        let p = await boot({ mfa: { policy: { force: true } }, register: withEnrolments(new Enrolments({ alice: ['totp'] })) });
        await refusedWith((await policyOf(p)).required(ALICE, PASSWORD), ['totp']);
        assert.deepStrictEqual(await (await policyOf(p)).required(BOB, PASSWORD), ['fake']);
        await p.dispose();
        const enrolments = withEnrolments(new Enrolments({ alice: ['totp'] }));
        p = await boot({
          mfa: { policy: { forceForRoles: ['admin'] } },
          register: (c) => {
            bind(c, RoleSource, 'KitRoles', new Roles(['admin']));
            enrolments(c);
          },
        });
        await refusedWith((await policyOf(p)).required(ALICE, PASSWORD), ['totp']);
      });

      it('requires the enrolled listed steps without asking the sources', async () => {
        const source = new Enrolments({ alice: ['totp'] });
        const p = await boot({ register: withEnrolments(source) });
        p.step.enrol(ALICE);
        assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), ['fake']);
        assert.deepStrictEqual(source.asked, []);
      });

      it('asks every source and refuses on the steps of any', async () => {
        const p = await boot({ steps: [], register: withEnrolments(new Enrolments({}), new Enrolments({ alice: ['totp'] }), new Enrolments({ alice: ['totp'] })) });
        await refusedWith((await policyOf(p)).required(ALICE, PASSWORD), ['totp']);
      });

      it('fails closed when a source throws: the error reaches the caller', async () => {
        const p = await boot({ steps: [], register: withEnrolments(new Enrolments(new RangeError('store down'))) });
        await assert.rejects((await policyOf(p)).required(ALICE, PASSWORD), RangeError);
      });

      it('leaves logins other than password alone, asking nothing (D13)', async () => {
        const source = new Enrolments({ alice: ['totp'] });
        const p = await boot({ steps: [], register: withEnrolments(source) });
        for (const method of ['oidc', 'key-challenge', 'token']) assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, { method, strategy: 's' }), [], method);
        assert.deepStrictEqual(source.asked, []);
      });
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
