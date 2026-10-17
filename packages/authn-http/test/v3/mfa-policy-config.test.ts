import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { MfaEnrolmentMismatch, MfaStepNotListed } from '@spinajs/authn';
import { MfaPolicy, Session } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { SESSION_PENDING_STEPS_KEY } from '@spinajs/authn-session';

import '../../src/api.js';
import { mfaPolicyOf } from '../../src/policies/v3/mfa.js';
import { pendingSteps } from '../../src/v3/routes.js';
import { boot, disposeBooted, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];

const policy = { required: async () => ['totp'], steps: async () => new Map() };
const named = { CustomPolicy: () => policy }.CustomPolicy;

const session = (stored?: unknown) => new Session({ handle: { id: 'x', state: 'pending' }, identity: { type: 'user', id: 'u1' }, facts: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) }, data: [[SESSION_PENDING_STEPS_KEY, stored]] });

describe('authn.mfa.policy.service through resolveNamedService', () => {
  afterEach(disposeBooted);

  it('defaults to DefaultMfaPolicy and names an empty service', async () => {
    const { configuration } = await boot(SCHEMAS, {});
    expect(configuration.get('authn.mfa.policy.service')).to.eq('DefaultMfaPolicy');
    expect(await violationsOf(SCHEMAS, { authn: { mfa: { policy: { service: '' } } } })).to.include('authn.mfa.policy.service');
  });

  it('mfaPolicyOf resolves the registration the configuration of its container names', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'CustomPolicy' } } } });
    child.register(named).as(MfaPolicy as never);
    expect(await mfaPolicyOf(child)).to.eq(policy);
  });

  it('mfaPolicyOf and pendingSteps refuse a name that is not registered, naming the key and the name', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'Missing' } } } });
    child.register(named).as(MfaPolicy as never);
    for (const ask of [() => mfaPolicyOf(child), () => pendingSteps(child, session(undefined))]) {
      let error: unknown;
      try {
        await ask();
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidOption);
      expect(String(error)).to.contain('authn.mfa.policy.service "Missing": no MfaPolicy is registered');
    }
  });

  it('pendingSteps asks the configured policy unless the session stored its steps', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'CustomPolicy' } } } });
    child.register(named).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined))).to.deep.eq(['totp']);
    expect(await pendingSteps(child, session(['recovery']))).to.deep.eq(['recovery']);
  });

  it('pendingSteps answers no step when the policy refuses the identity over its stored enrolments; another error still throws', async () => {
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy: { service: 'RefusingPolicy' } } } });
    let failure: Error = new MfaStepNotListed(['totp']);
    const refusing = { required: async () => Promise.reject(failure), steps: async () => new Map() };
    child.register({ RefusingPolicy: () => refusing }.RefusingPolicy).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined))).to.deep.eq([]);
    failure = new MfaEnrolmentMismatch(['totp']);
    expect(await pendingSteps(child, session([]))).to.deep.eq([]);
    failure = new RangeError('mfa store down');
    let error: unknown;
    try {
      await pendingSteps(child, session(undefined));
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(RangeError);
  });
});
