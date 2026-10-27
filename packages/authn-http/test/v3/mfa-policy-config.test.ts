import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { MfaEnrolmentMismatch, MfaStepNotListed } from '@spinajs/authn';
import { MfaPolicy, Session } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { SESSION_PENDING_STEPS_KEY } from '@spinajs/authn-session';

import '../../src/api.js';
import { MfaSatisfied, mfaPolicyOf } from '../../src/policies/v3/mfa.js';
import { pendingSteps } from '../../src/v3/routes.js';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];

const policy = { required: async () => ['totp'], steps: async () => new Map() };
const named = { CustomPolicy: () => policy }.CustomPolicy;

const session = (stored?: unknown) => new Session({ handle: { id: 'x', state: 'pending' }, identity: { type: 'user', id: 'u1' }, facts: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) }, data: [[SESSION_PENDING_STEPS_KEY, stored]] });

describe('authn.mfa.policy.service through @Config', () => {
  afterEach(disposeTestApps);

  it('defaults to DefaultMfaPolicy and names an empty service', async () => {
    const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect(configuration.get('authn.mfa.policy.service')).to.eq('DefaultMfaPolicy');
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { mfa: { policy: { service: '' } } } } })).to.include('authn.mfa.policy.service');
  });

  it('MfaSatisfied reads the configured name from its container', async () => {
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { mfa: { policy: { service: 'CustomPolicy' } } } } });
    expect((readingFrom(new MfaSatisfied(), child) as unknown as { PolicyService: string }).PolicyService).to.eq('CustomPolicy');
    const { container: other } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect((readingFrom(new MfaSatisfied(), other) as unknown as { PolicyService: string }).PolicyService).to.eq('DefaultMfaPolicy');
  });

  it('mfaPolicyOf finds the registration by the name it is given, with no fallback of its own', async () => {
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
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
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
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
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    child.register(named).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined), 'CustomPolicy')).to.deep.eq(['totp']);
    expect(await pendingSteps(child, session(['recovery']), 'CustomPolicy')).to.deep.eq(['recovery']);
  });

  it('pendingSteps answers no step when the policy refuses the identity over its stored enrolments; another error still throws', async () => {
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    let failure: Error = new MfaStepNotListed(['totp']);
    const refusing = { required: async () => Promise.reject(failure), steps: async () => new Map() };
    child.register({ RefusingPolicy: () => refusing }.RefusingPolicy).as(MfaPolicy as never);
    expect(await pendingSteps(child, session(undefined), 'RefusingPolicy')).to.deep.eq([]);
    failure = new MfaEnrolmentMismatch(['totp']);
    expect(await pendingSteps(child, session([]), 'RefusingPolicy')).to.deep.eq([]);
    failure = new RangeError('mfa store down');
    let error: unknown;
    try {
      await pendingSteps(child, session(undefined), 'RefusingPolicy');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(RangeError);
  });
});
