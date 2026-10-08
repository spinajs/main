import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { KeyRegistry } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import type { IContainer } from '@spinajs/di';
import type { BasePolicy, IController, IRoute, Request } from '@spinajs/http';

import '../../src/api.js';
import { KeyRoutesOn } from '../../src/keys/gate.js';
import { TOTP_SERVICE, TotpEnrolmentOn } from '../../src/mfa/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const AUDIENCE = 'https://gate-config.example.test';
const MFA_KEY = 'ab'.repeat(32);

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

  it('TotpEnrolmentOn stays off without asking its container anything while the configuration of its container sets no MFA key', async () => {
    const gateWith = async (values: Record<string, unknown>) => {
      const { child } = await boot(SCHEMAS, values);
      child.register({ TotpService: class {} }.TotpService).asSelf();
      const resolve = sinon.stub(child, 'resolve').rejects(new Error('asked the container'));
      return { resolve, answer: answer(new TotpEnrolmentOn(), child) };
    };
    const unset = await gateWith({});
    expect(await unset.answer).to.eq('not_found');
    expect(unset.resolve.called).to.eq(false);

    const set = await gateWith({ authn: { mfa: { encryptionKey: { secret: MFA_KEY } } } });
    let error: unknown;
    await set.answer.catch((e: unknown) => (error = e));
    expect((error as Error | undefined)?.message, 'a key set: the gate goes on to the step registry').to.eq('asked the container');
    expect(set.resolve.called).to.eq(true);
    expect(TOTP_SERVICE).to.eq('TotpService');
  });

  it('the schema refuses an MFA key that is empty or not 32 bytes, so TotpEnrolmentOn never meets one', async () => {
    for (const secret of ['', 'ab'.repeat(8)]) {
      expect(await violationsOf(SCHEMAS, { authn: { mfa: { encryptionKey: { secret } } } }), JSON.stringify(secret)).to.include('authn.mfa.encryptionKey.secret');
    }
  });
});
