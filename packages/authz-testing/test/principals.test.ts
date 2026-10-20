import { expect } from 'chai';
import 'mocha';

import * as authz from '@spinajs/authz';
import { GLOBAL } from '@spinajs/authz';

import { SYSTEM, UNATTENDED, agentPrincipal, anonymousPrincipal, groupPrincipal, linkPrincipal, servicePrincipal, userPrincipal, withAttributes, withAuthn, withCeiling, withCompanions } from '../src/index.js';

describe('principal builders', () => {
  it('userPrincipal is a frozen, authenticated session user', () => {
    const p = userPrincipal('42', { attributes: { pool: 'p1' } });
    expect(p).to.deep.include({ type: 'user', id: '42', authenticated: true, source: 'session' });
    expect(p.attributes).to.deep.eq({ pool: 'p1' });
    expect(Object.isFrozen(p)).to.eq(true);
    expect(Object.isFrozen(p.attributes)).to.eq(true);
  });

  it('anonymous, service and group principals', () => {
    expect(anonymousPrincipal()).to.deep.include({ type: 'anonymous', id: 'anonymous', authenticated: false });
    expect(servicePrincipal('telemetry')).to.deep.include({ type: 'service', id: 'telemetry', authenticated: true, source: 'token' });
    expect(groupPrincipal('admins')).to.deep.include({ type: 'group', id: 'admins', authenticated: true });
  });

  it('linkPrincipal carries a ceiling on its scope with reason link_invalid, and companions', () => {
    const at = new Date('2030-01-01T00:00:00Z');
    const companion = userPrincipal('7');
    const l = linkPrincipal('l1', { scope: { type: 'file', id: 'f1' }, expiresAt: at, companions: [companion] });
    expect(l).to.deep.include({ type: 'link', id: 'l1', authenticated: true, source: 'link' });
    expect(l.ceiling).to.deep.eq({ resources: [{ type: 'file', id: 'f1' }], expiresAt: at, reason: 'link_invalid' });
    expect(l.companions).to.deep.eq([{ type: 'user', id: '7' }]);
    expect(Object.isFrozen(l.ceiling)).to.eq(true);
    expect(Object.isFrozen(l.ceiling!.resources)).to.eq(true);
    expect(Object.isFrozen(l.companions)).to.eq(true);
  });

  it('agentPrincipal speaks for its delegate, inherit by default, ceiling reason out_of_scope', () => {
    const owner = userPrincipal('1');
    const a = agentPrincipal('bot', owner, { permissions: ['file:read'] });
    expect(a.onBehalfOf).to.eq(owner);
    expect(a.delegation).to.eq('inherit');
    expect(a.ceiling).to.deep.eq({ permissions: ['file:read'], reason: 'out_of_scope' });
    expect(agentPrincipal('bot', owner, { delegation: 'intersect' }).delegation).to.eq('intersect');
    expect(agentPrincipal('bot', owner).ceiling).to.eq(undefined);
  });

  it('with* helpers return new frozen principals and leave the input alone', () => {
    const p = userPrincipal('1', { attributes: { a: 1 } });
    const c = withCeiling(p, { roles: ['viewer'], resources: [GLOBAL] });
    expect(c.ceiling).to.deep.eq({ roles: ['viewer'], resources: [GLOBAL] });
    expect(p.ceiling).to.eq(undefined);
    expect(Object.isFrozen(c)).to.eq(true);

    const w = withAttributes(p, { b: 2 });
    expect(w.attributes).to.deep.eq({ a: 1, b: 2 });
    expect(p.attributes).to.deep.eq({ a: 1 });

    const m = withCompanions(p, [{ type: 'user', id: '9' }]);
    expect(m.companions).to.deep.eq([{ type: 'user', id: '9' }]);
  });

  it('withAuthn fills deterministic defaults and derives the assurance from mfa', () => {
    const p = withAuthn(userPrincipal('1'));
    expect(p.authn).to.deep.eq({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) });
    expect(withAuthn(userPrincipal('1'), { mfa: ['totp'] }).authn!.assurance).to.eq('aal2');
    expect(withAuthn(userPrincipal('1'), { mfa: ['totp'], assurance: 'aal1' }).authn!.assurance).to.eq('aal1');
    expect(Object.isFrozen(p.authn)).to.eq(true);
  });

  it('SYSTEM and UNATTENDED are the core singletons, not copies', () => {
    expect(SYSTEM).to.eq(authz.SYSTEM);
    expect(UNATTENDED).to.eq(authz.UNATTENDED);
  });
});
