import * as chai from 'chai';
import 'mocha';

import * as principalPackage from '@spinajs/principal';
import { SYSTEM, UNATTENDED, principalKey, ceilingHash } from '../../src/index.js';
import type { AuthnFacts, Ceiling, Principal, PrincipalRef, PrincipalType, ResourceRef, ResourceType } from '../../src/index.js';

const expect = chai.expect;

describe('authz re-exports the principal contracts', () => {
  it('re-exports the same runtime objects as @spinajs/principal', () => {
    expect(SYSTEM).to.eq(principalPackage.SYSTEM);
    expect(UNATTENDED).to.eq(principalPackage.UNATTENDED);
    expect(principalKey).to.eq(principalPackage.principalKey);
    expect(ceilingHash).to.eq(principalPackage.ceilingHash);
  });

  it('re-exports the principal types', () => {
    const type: PrincipalType = 'user';
    const ref: PrincipalRef = { type, id: '1' };
    const resourceType: ResourceType = 'file';
    const resource: ResourceRef = { type: resourceType, id: 'a' };
    const ceiling: Ceiling = { resources: [resource] };
    const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };
    const principal: Principal = { ...ref, authenticated: true, source: 'session', attributes: {}, ceiling, authn: facts };
    const fromPackage: principalPackage.Principal = principal;

    expect(principalKey(fromPackage)).to.eq('user:1');
  });
});
