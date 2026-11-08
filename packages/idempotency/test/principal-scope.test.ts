import 'mocha';
import { expect } from 'chai';
import type { Principal } from '@spinajs/principal';
import { idempotencyPrincipal, isRestrictedPrincipal } from '../src/index.js';

const user = (extra: Partial<Principal> = {}): Principal => ({ type: 'user', id: 'u1', authenticated: true, source: 'session', attributes: {}, ...extra });

const authn = (impersonator?: { type: string; id: string }) => ({ method: 'password', strategy: 'local', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(0), ...(impersonator ? { impersonator } : {}) });

describe('idempotency principal scope', () => {
  it('keeps the principal key of an unrestricted principal, the scope of earlier records', () => {
    expect(isRestrictedPrincipal(user())).to.eq(false);
    expect(idempotencyPrincipal(user())).to.eq('user:u1');
    expect(idempotencyPrincipal(user({ authn: authn() }))).to.eq('user:u1');
  });

  it('gives every restricted credential of one identity a scope of its own', () => {
    const scopes = [
      user(),
      user({ ceiling: { roles: ['viewer'] } }),
      user({ ceiling: { roles: ['editor'] } }),
      user({ ceiling: { permissions: ['file:read'] } }),
      user({ authn: authn({ type: 'user', id: 'admin' }) }),
      user({ authn: authn({ type: 'user', id: 'other-admin' }) }),
      user({ onBehalfOf: user({ id: 'u2' }) }),
      user({ onBehalfOf: user({ id: 'u2' }), delegation: 'inherit' }),
      user({ companions: [{ type: 'user', id: 'alice' }] }),
      { type: 'link', id: 'L1', authenticated: true, source: 'link', attributes: {}, ceiling: { resources: [{ type: 'item' }] } } as Principal,
      { type: 'link', id: 'L1', authenticated: true, source: 'link', attributes: {}, ceiling: { resources: [{ type: 'item' }] }, companions: [{ type: 'user', id: 'alice' }] } as Principal,
    ].map(idempotencyPrincipal);

    expect(new Set(scopes).size).to.eq(scopes.length);
  });

  it('marks a link bearer restricted even without a ceiling', () => {
    expect(isRestrictedPrincipal({ type: 'link', id: 'L1', authenticated: true, source: 'link', attributes: {} })).to.eq(true);
  });

  it('does not depend on the order of companions or ceiling roles', () => {
    const a = user({ ceiling: { roles: ['a', 'b'] }, companions: [{ type: 'user', id: 'x' }, { type: 'user', id: 'y' }] });
    const b = user({ ceiling: { roles: ['b', 'a'] }, companions: [{ type: 'user', id: 'y' }, { type: 'user', id: 'x' }] });
    expect(idempotencyPrincipal(a)).to.eq(idempotencyPrincipal(b));
  });
});
