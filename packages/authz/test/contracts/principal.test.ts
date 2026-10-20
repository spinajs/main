import * as chai from 'chai';
import 'mocha';

import * as authn from '@spinajs/authn/contracts';
import { SYSTEM, UNATTENDED, principalKey, ceilingHash } from '../../src/index.js';
import type { AuthnFacts, Ceiling, Principal, PrincipalRef, PrincipalType, ResourceRef, ResourceType } from '../../src/index.js';

const expect = chai.expect;

describe('authz re-exports the principal contracts', () => {
  it('re-exports the same runtime objects as @spinajs/authn/contracts', () => {
    expect(SYSTEM).to.eq(authn.SYSTEM);
    expect(UNATTENDED).to.eq(authn.UNATTENDED);
    expect(principalKey).to.eq(authn.principalKey);
    expect(ceilingHash).to.eq(authn.ceilingHash);
  });

  it('re-exports the principal types', () => {
    const type: PrincipalType = 'user';
    const ref: PrincipalRef = { type, id: '1' };
    const resourceType: ResourceType = 'file';
    const resource: ResourceRef = { type: resourceType, id: 'a' };
    const ceiling: Ceiling = { resources: [resource] };
    const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };
    const principal: Principal = { ...ref, authenticated: true, source: 'session', attributes: {}, ceiling, authn: facts };
    const fromAuthn: authn.Principal = principal;

    expect(principalKey(fromAuthn)).to.eq('user:1');
  });
});
