import 'mocha';
import { expect } from 'chai';
import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { signalPrincipal } from '../src/principal.js';

const user: Principal = { type: 'user', id: 'u1', authenticated: true, source: 'session', attributes: {} };

describe('signalPrincipal', () => {
  it('stamps a plain signed-in principal with its principal key', () => {
    expect(signalPrincipal(user)).to.equal('user:u1');
    expect(signalPrincipal({ ...user, type: 'svc:a' })).to.equal('svc%3Aa:u1');
  });

  it('refuses a request without an authenticated principal', () => {
    for (const p of [undefined, null, UNATTENDED, { ...user, authenticated: false }]) expect(() => signalPrincipal(p)).to.throw(AuthenticationFailed);
  });

  it('refuses the principal types a wait must never run as', () => {
    for (const p of [SYSTEM, { ...user, type: 'system' }, { ...user, type: 'unattended' }, { ...user, type: 'anonymous' }]) {
      expect(() => signalPrincipal(p)).to.throw(Forbidden, 'principal cannot sign a workflow signal');
    }
  });

  it('refuses a credential that holds less than its identity', () => {
    const restricted: Principal[] = [
      { ...user, ceiling: { permissions: ['workflow:signal'] } },
      { ...user, onBehalfOf: user },
      { ...user, type: 'link' },
      { ...user, companions: [{ type: 'user', id: 'u2' }] },
      { ...user, authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0), impersonator: { type: 'user', id: 'admin' } } },
    ];
    for (const p of restricted) expect(() => signalPrincipal(p)).to.throw(Forbidden, 'a restricted credential cannot sign a workflow signal');
  });
});
