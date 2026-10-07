import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { MfaPolicy } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import { SESSION_PENDING_STEPS_KEY } from '@spinajs/authn-session';

import '../../src/api.js';
import { MfaSatisfied, mfaPolicyOf } from '../../src/policies/v3/mfa.js';
import { pendingSteps } from '../../src/v3/routes.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];

const policy = { required: async () => ['totp'] };
const named = { CustomPolicy: () => policy }.CustomPolicy;

const session = (stored?: unknown) => ({ data: new Map([[SESSION_PENDING_STEPS_KEY, stored]]), identity: { type: 'user', id: 'u1' }, facts: { method: 'password', strategy: 'local' } }) as never;

describe('authn.mfa.policy.service through @Config', () => {
  afterEach(disposeBooted);

  it('defaults to DefaultMfaPolicy and names an empty service', async () => {
    const { configuration } = await boot(SCHEMAS, {});
    expect(configuration.get('authn.mfa.policy.service')).to.eq('DefaultMfaPolicy');
    expect(await violationsOf(SCHEMAS, { authn: { mfa: { policy: { service: '' } } } })).to.include('authn.mfa.policy.service');
  });

  it('MfaSatisfied reads the configured name from its container', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'CustomPolicy' } } } });
    expect((readingFrom(new MfaSatisfied(), child) as unknown as { PolicyService: string }).PolicyService).to.eq('CustomPolicy');
    const { child: other } = await boot(SCHEMAS, {});
    expect((readingFrom(new MfaSatisfied(), other) as unknown as { PolicyService: string }).PolicyService).to.eq('DefaultMfaPolicy');
  });

  it('mfaPolicyOf finds the registration by the name it is given, with no fallback of its own', async () => {
    const { child } = await boot(SCHEMAS, {});
    child.register(named).as(MfaPolicy as never);
    expect(await mfaPolicyOf(child, 'CustomPolicy')).to.eq(policy);
    let error: unknown;
    try {
      await mfaPolicyOf(child, 'Missing');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect(String(error)).to.contain('no MfaPolicy is registered');
  });

  it('mfaPolicyOf and pendingSteps refuse a name that came past the schema unset or empty', async () => {
    const { child } = await boot(SCHEMAS, {});
    child.register(named).as(MfaPolicy as never);
    for (const name of [undefined, '']) {
      for (const ask of [() => mfaPolicyOf(child, name as unknown as string), () => pendingSteps(child, session(undefined), name as unknown as string)]) {
        let error: unknown;
        try {
          await ask();
        } catch (e) {
          error = e;
        }
        expect(error, String(name)).to.be.instanceOf(InvalidOption);
      }
    }
  });

  it('pendingSteps asks the named policy unless the session stored its steps', async () => {
    const { child } = await boot(SCHEMAS, {});
    child.register(named).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined), 'CustomPolicy')).to.deep.eq(['totp']);
    expect(await pendingSteps(child, session(['recovery']), 'CustomPolicy')).to.deep.eq(['recovery']);
  });
});
