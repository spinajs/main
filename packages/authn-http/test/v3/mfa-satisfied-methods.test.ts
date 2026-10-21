import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import { DefaultMfaPolicy } from '@spinajs/authn';
import { MfaPolicy, MfaStep } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { FakeMfaStep } from '@spinajs/authn-testing';
import { Forbidden } from '@spinajs/exceptions';
import type { IController, IRoute, Request } from '@spinajs/http';

import '../../src/api.js';
import { MfaSatisfied } from '../../src/policies/v3/mfa.js';
import { boot, disposeBooted, readingFrom } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const route = { Method: 'probe' } as unknown as IRoute;
const controller = {} as IController;

const requestOf = (authn: Partial<AuthnFacts>): Request =>
  ({ storage: { AuthnPrincipal: { ...ALICE, authenticated: true, source: 'session', attributes: {}, authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...authn } } } }) as unknown as Request;

describe('MfaSatisfied by login method (SEC-7)', () => {
  afterEach(disposeBooted);

  async function policyFor(methods?: string[], enrolled = true): Promise<MfaSatisfied> {
    const policy = methods ? { methods } : {};
    const { child } = await boot(SCHEMAS, { authn: { mfa: { policy, steps: [{ name: 'totp', service: 'MethodsSuiteStep' }] } } });
    const step = new FakeMfaStep({ name: 'totp' });
    if (enrolled) step.enrol(ALICE);
    child.register({ MethodsSuiteStep: () => step }.MethodsSuiteStep).as(MfaStep as never);
    child.register(DefaultMfaPolicy).as(MfaPolicy as never);
    const satisfied = readingFrom(new MfaSatisfied(), child);
    Object.defineProperty(satisfied, 'Container', { value: child as IContainer });
    return satisfied;
  }

  async function outcome(p: MfaSatisfied, authn: Partial<AuthnFacts>): Promise<string> {
    try {
      await p.execute(requestOf(authn), route, controller);
      return 'pass';
    } catch (e) {
      if (e instanceof Forbidden) return `403 ${(e as { error?: string }).error}`;
      throw e;
    }
  }

  const OIDC = { method: 'oidc', strategy: 'oidc:kit' };

  it('passes an aal1 OIDC session of an enrolled identity under the default (documented behaviour)', async () => {
    expect(await outcome(await policyFor(), OIDC)).to.eq('pass');
  });

  it('refuses the same session with 403 mfa_required once methods lists oidc', async () => {
    expect(await outcome(await policyFor(['password', 'oidc']), OIDC)).to.eq('403 mfa_required');
  });

  it('passes an aal2 OIDC session whatever methods lists', async () => {
    expect(await outcome(await policyFor(['password', 'oidc']), { ...OIDC, assurance: 'aal2', mfa: ['totp'] })).to.eq('pass');
  });

  it('passes an OIDC session of an identity with no enrolment', async () => {
    expect(await outcome(await policyFor(['password', 'oidc'], false), OIDC)).to.eq('pass');
  });

  it('keeps passing key and token principals that methods leaves out', async () => {
    const p = await policyFor(['password', 'oidc']);
    for (const method of ['jws', 'token', 'key-challenge']) expect(await outcome(p, { method, strategy: 's' }), method).to.eq('pass');
  });

  it('still refuses an aal1 password session by default', async () => {
    expect(await outcome(await policyFor(), { method: 'password', strategy: 'local' })).to.eq('403 mfa_required');
  });
});
