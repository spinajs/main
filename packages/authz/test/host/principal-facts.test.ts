import * as chai from 'chai';
import 'mocha';

import { principalFacts } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

const expect = chai.expect;

const user = (id: string, extra: Partial<Principal> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: { email: `${id}@example.com` }, ...extra });

describe('principalFacts', () => {
  it('keeps type and id only for a plain principal: no attributes, authn, source or identity', () => {
    const p = user('alice', { identity: { secret: 1 }, authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() } });
    expect(principalFacts(p)).to.deep.equal({ type: 'user', id: 'alice' });
  });

  it('keeps the ceiling, the delegation chain and the companion keys', () => {
    const agent: Principal = {
      type: 'agent',
      id: 'bot',
      authenticated: true,
      source: 'token',
      attributes: {},
      onBehalfOf: user('alice', { ceiling: { roles: ['viewer'] } }),
      delegation: 'inherit',
      companions: [{ type: 'user', id: 'carol' }, { type: 'a:b', id: 'x' }],
      ceiling: { permissions: ['doc:*'], resources: [{ type: 'doc', id: 'd1' }, { type: 'project' }], expiresAt: new Date('2026-12-01T00:00:00Z'), reason: 'token_scope' },
    };
    expect(principalFacts(agent)).to.deep.equal({
      type: 'agent',
      id: 'bot',
      ceiling: { permissions: ['doc:*'], resources: [{ type: 'doc', id: 'd1' }, { type: 'project' }], expiresAt: '2026-12-01T00:00:00.000Z' },
      onBehalfOf: { type: 'user', id: 'alice', ceiling: { roles: ['viewer'] } },
      delegation: 'inherit',
      companions: ['user:carol', 'a%3Ab:x'],
    });
  });

  it('keeps an empty ceiling list apart from an absent one', () => {
    expect(principalFacts(user('a', { ceiling: { resources: [] } }))).to.deep.equal({ type: 'user', id: 'a', ceiling: { resources: [] } });
  });

  it('gives none over 4 KB (a long chain included), for a cycle or an invalid expiry', () => {
    expect(principalFacts(user('a', { ceiling: { permissions: ['p'.repeat(4096)] } }))).to.equal(undefined);
    expect(principalFacts(user('a', { ceiling: { permissions: ['p'.repeat(3900)] } }))).to.not.equal(undefined);

    const looped = { ...user('a') } as { onBehalfOf?: Principal } & Principal;
    looped.onBehalfOf = looped;
    expect(principalFacts(looped)).to.equal(undefined);

    let wide: Principal = user('root');
    for (let i = 0; i < 200; i++) wide = user(`d${i}`, { onBehalfOf: wide });
    expect(principalFacts(wide)).to.equal(undefined);

    expect(principalFacts(user('a', { ceiling: { expiresAt: new Date(Number.NaN) } }))).to.equal(undefined);
  });

  it('keeps a delegation chain deeper than the default maxDelegation, which an app may raise', () => {
    let chain: Principal = user('root');
    for (let i = 0; i < 12; i++) chain = user(`d${i}`, { onBehalfOf: chain, delegation: 'intersect' });
    let depth = 0;
    for (let f = principalFacts(chain); f?.onBehalfOf; f = f.onBehalfOf) depth++;
    expect(depth).to.equal(12);
  });
});
