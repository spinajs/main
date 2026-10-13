import assert from 'node:assert/strict';
import 'mocha';
import { FakeMfaStep, fakeHash } from '@spinajs/authn-testing';
import { Injectable } from '@spinajs/di';

import { AuthnService, MfaStep, RECOVERY_STEP, mfaSteps } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, IdentityRef } from '../../src/index.js';
import { KIT_MFA_STEP, bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

// Samples of src/flow/README.md, kept compiling and passing.

@Injectable(MfaStep)
export class EmailCodeStep extends MfaStep {
  readonly name = 'email-code';

  async enrolled(id: IdentityRef): Promise<boolean> {
    return id.id.length > 0;
  }

  async beginEnrolment(_id: IdentityRef): Promise<{ provisioning: string }> {
    return { provisioning: 'a code was sent' };
  }

  async confirmEnrolment(_id: IdentityRef, _response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    return {};
  }

  async verify(_id: IdentityRef, response: string): Promise<boolean> {
    return response === '123456';
  }

  async disable(_id: IdentityRef): Promise<void> {}
}

async function loginWithOneStep(authn: AuthnService, ctx: AuthnContext, code: (steps: readonly string[]) => Promise<string>): Promise<AuthenticationResult> {
  const first = await authn.authenticate({ kind: 'password', login: 'alice@example.test', password: 'Alice-Pass-1234' }, ctx);
  if (first.status !== 'mfa_required') return first;
  const [step] = first.steps;
  return authn.completeMfa(first.pending, step, await code(first.steps), ctx);
}

async function loginWithAnyStep(authn: AuthnService, ctx: AuthnContext, ask: (steps: readonly string[]) => Promise<{ step: string; code: string }>): Promise<AuthenticationResult> {
  const first = await authn.authenticate({ kind: 'password', login: 'alice@example.test', password: 'Alice-Pass-1234' }, ctx);
  if (first.status !== 'mfa_required') return first;
  const { step, code } = await ask(first.steps);
  // The step is one of first.steps, or RECOVERY_STEP with a recovery code.
  return authn.completeMfa(first.pending, step, code, ctx);
}

async function stepsOfContainer(p: CoreParts): Promise<string[]> {
  return [...(await mfaSteps(p.child)).keys()];
}

describe('flow README examples', function () {
  this.timeout(30000);
  useHarnessLog();

  let parts: CoreParts | undefined;
  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.10', purpose: 'login' });

  async function boot(): Promise<{ p: CoreParts; alice: IdentityRef; second: FakeMfaStep }> {
    const second = new FakeMfaStep({ name: 'second', recoveryCodes: false });
    parts = await buildCore(
      {},
      {
        raw: { authn: { mfa: { steps: [{ name: 'fake', service: KIT_MFA_STEP }, { name: 'second', service: 'Step_second' }] } } },
        register: (c) => bind(c, MfaStep, 'Step_second', second),
      },
    );
    const alice = parts.identities.add({ login: 'alice@example.test', email: 'alice@example.test' });
    await parts.passwords.set(alice, fakeHash('Alice-Pass-1234'));
    return { p: parts, alice, second };
  }

  it('one step: authenticate, then completeMfa', async () => {
    const { p, alice } = await boot();
    p.step.enrol(alice);
    const r = await loginWithOneStep(p.service, ctx(), async () => p.step.nextCode(alice));
    assert.strictEqual(r.status, 'success');
    assert.strictEqual((r as Extract<AuthenticationResult, { status: 'success' }>).facts.assurance, 'aal2');
  });

  it('several steps: any one passes, and the recovery step takes a recovery code', async () => {
    const { p, alice, second } = await boot();
    p.step.enrol(alice);
    second.enrol(alice);

    let offered: readonly string[] = [];
    const ok = await loginWithAnyStep(p.service, ctx(), async (steps) => {
      offered = steps;
      return { step: 'second', code: second.nextCode(alice) };
    });
    assert.deepStrictEqual([...offered], ['fake', 'second']);
    assert.strictEqual(ok.status, 'success');

    const [recovery] = await p.step.regenerateRecoveryCodes!(alice);
    const viaRecovery = await loginWithAnyStep(p.service, ctx(), async () => ({ step: RECOVERY_STEP, code: recovery }));
    assert.strictEqual(viaRecovery.status, 'success');
  });

  it('a step class written against the contract is a plain MfaStep', async () => {
    const { p } = await boot();
    assert.strictEqual(new EmailCodeStep().storesSecrets, false);
    assert.deepStrictEqual(await stepsOfContainer(p), ['fake', 'second']);
  });
});
