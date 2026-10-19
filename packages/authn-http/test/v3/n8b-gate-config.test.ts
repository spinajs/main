import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { KeyRegistry, MfaEnrolmentService, MfaPolicy } from '@spinajs/authn/contracts';
import type { MfaStep } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import type { IContainer } from '@spinajs/di';
import type { BasePolicy, IController, IRoute, Request } from '@spinajs/http';

import '../../src/api.js';
import { KeyRoutesOn } from '../../src/keys/gate.js';
import { TotpEnrolmentOn } from '../../src/mfa/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const AUDIENCE = 'https://gate-config.example.test';

/** `gate` built the way DI builds it from `container`: its Container and the container its `@Config` reads. */
async function answer(gate: BasePolicy, container: IContainer): Promise<'open' | 'not_found'> {
  (gate as unknown as { Container: IContainer }).Container = container;
  readingFrom(gate, container);
  try {
    await gate.execute({ storage: {} } as unknown as Request, {} as IRoute, {} as IController);
    return 'open';
  } catch (e) {
    if ((e as object).constructor.name !== 'ResourceNotFound') throw e;
    expect((e as { error?: unknown }).error).to.eq('not_found');
    return 'not_found';
  }
}

describe('the N8b route gates read authn.* through @Config', function () {
  this.timeout(20000);

  afterEach(async () => {
    sinon.restore();
    await disposeBooted();
  });

  it('KeyRoutesOn opens on the audience of its container, the challenge audience falling back to the assertion audience as in authn-keys', async () => {
    const keysGate = async (keys: Record<string, unknown> | undefined, registry = true) => {
      const { child } = await boot(SCHEMAS, keys === undefined ? {} : { authn: { keys } });
      if (registry) child.register({ StubKeyRegistry: () => ({}) }.StubKeyRegistry).as(KeyRegistry as never);
      return answer(new KeyRoutesOn(), child);
    };
    expect(await keysGate(undefined), 'no authn.keys').to.eq('not_found');
    expect(await keysGate({ challenge: { audience: null }, assertion: { audience: null } }), 'null audiences').to.eq('not_found');
    expect(await keysGate({ assertion: { audience: AUDIENCE } }), 'assertion.audience').to.eq('open');
    expect(await keysGate({ challenge: { audience: AUDIENCE } }), 'challenge.audience').to.eq('open');
    expect(await keysGate({ challenge: { audience: AUDIENCE }, assertion: { audience: AUDIENCE } }, false), 'no KeyRegistry').to.eq('not_found');
  });

  it('the schema refuses an audience that is empty or not a string, so KeyRoutesOn never meets one', async () => {
    const paths = await violationsOf(SCHEMAS, { authn: { keys: { challenge: { audience: '' }, assertion: { audience: { url: AUDIENCE } } } } });
    expect(paths).to.include.members(['authn.keys.challenge.audience', 'authn.keys.assertion.audience']);
  });

  it('TotpEnrolmentOn stays off without resolving anything while its container registers no MfaEnrolmentService', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { steps: [{ name: 'totp', service: 'TotpMfaStep' }] } } });
    child.register({ TotpService: class {} }.TotpService).asSelf();
    expect(child.hasRegistered(MfaEnrolmentService as never)).to.eq(false);
    const resolve = sinon.stub(child, 'resolve').rejects(new Error('asked the container'));
    const resolveNamed = sinon.stub(child, 'resolveNamed').rejects(new Error('asked the container'));
    const names = sinon.stub(child, 'getRegisteredNames').throws(new Error('asked the container'));
    expect(await answer(new TotpEnrolmentOn(), child)).to.eq('not_found');
    expect(resolve.called || resolveNamed.called || names.called).to.eq(false);
  });

  it('TotpEnrolmentOn asks the MfaEnrolmentService of its container over the steps of the policy authn.mfa.policy.service names there', async () => {
    const step = { name: 'totp' } as MfaStep;
    const GateSpecMfaPolicy = class {
      required = async () => [];
      steps = async () => new Map([['totp', step]]);
    };
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'GateSpecMfaPolicy' } } } });
    child.register(GateSpecMfaPolicy).as(MfaPolicy as never);
    const seen: MfaStep[][] = [];
    let on = false;
    child.register(
      class SpecEnrolment {
        enabled = (steps: Iterable<MfaStep>) => (seen.push([...steps]), on);
      },
    ).as(MfaEnrolmentService as never);
    expect(await answer(new TotpEnrolmentOn(), child)).to.eq('not_found');
    on = true;
    expect(await answer(new TotpEnrolmentOn(), child)).to.eq('open');
    expect(seen).to.deep.eq([[step], [step]]);
  });

  it('the schema refuses an MFA key that is empty or not 32 bytes, so TotpService.enabled never meets one', async () => {
    for (const secret of ['', 'ab'.repeat(8)]) {
      expect(await violationsOf(SCHEMAS, { authn: { mfa: { encryptionKey: { secret } } } }), JSON.stringify(secret)).to.include('authn.mfa.encryptionKey.secret');
    }
  });
});
