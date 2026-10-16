import * as chai from 'chai';
import 'mocha';

import { Session, SessionKeys, sessionKey } from '../../src/contracts/session-state.js';
import * as index from '../../src/contracts/index.js';
import type { AuthnFacts } from '../../src/contracts/principal.js';

const expect = chai.expect;

const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };
const session = (data: [string, unknown][] = [], state: 'pending' | 'active' = 'active') => new Session({ handle: { id: 's1', state }, identity: { type: 'user', id: 'u1' }, facts, data });
const AT = '2026-01-01T00:00:00.000Z';

describe('Session', () => {
  it('is exported from the contracts index', () => {
    expect(index.Session).to.eq(Session);
    expect(index.SessionKeys).to.eq(SessionKeys);
    expect(index.sessionKey).to.eq(sessionKey);
  });

  it('keeps handle, identity and facts, and a copy of the data', () => {
    const data = new Map<string, unknown>([['k', 1]]);
    const s = new Session({ handle: { id: 's1', state: 'active' }, identity: { type: 'user', id: 'u1' }, facts: { ...facts, impersonator: { type: 'user', id: 'admin' } }, data });
    data.set('k', 2);
    expect(s.data.get('k')).to.eq(1);
    expect(s.state).to.eq('active');
    expect(s.impersonator).to.deep.eq({ type: 'user', id: 'admin' });
    expect(new Session({ handle: { id: 's', state: 'pending' }, identity: { type: 'user', id: 'u' }, facts }).data.size).to.eq(0);
  });

  it('two sessions built alike deep-equal: no own state beyond the four fields', () => {
    expect(Object.keys(session([['k', 1]]))).to.deep.eq(['handle', 'identity', 'facts', 'data']);
    expect(session([['k', 1]])).to.deep.eq(session([['k', 1]]));
  });

  it('get answers undefined for an absent key and hands every present value to the decoder, null included', () => {
    const seen: unknown[] = [];
    const probe = sessionKey('Probe', (raw) => (seen.push(raw), 'decoded'));
    expect(session().get(probe)).to.eq(undefined);
    expect(session().has(probe)).to.eq(false);
    expect(session([['Probe', null]]).get(probe)).to.eq('decoded');
    expect(session([['Probe', 1]]).has(probe)).to.eq(true);
    expect(seen).to.deep.eq([null]);
  });

  it('ActiveRole: none when absent or null, the role for a non-empty string, no role for anything else', () => {
    expect(session().activeRole).to.eq(undefined);
    expect(session([['ActiveRole', null]]).activeRole).to.eq(undefined);
    expect(session([['ActiveRole', 'editor']]).activeRole).to.eq('editor');
    for (const bad of ['', 42, ['admin'], { role: 'admin' }, true]) expect(session([['ActiveRole', bad]]).activeRole, JSON.stringify(bad)).to.eq('');
  });

  it('Impersonation: an ISO or Date start and at most one actor role; anything else is null', () => {
    expect(session().impersonation).to.eq(undefined);
    expect(session([['Impersonation', { startedAt: AT }]]).impersonation).to.deep.eq({ startedAt: new Date(AT) });
    expect(session([['Impersonation', { startedAt: new Date(AT), actorRoles: ['user'] }]]).impersonation).to.deep.eq({ startedAt: new Date(AT), actorRoles: ['user'] });
    expect(session([['Impersonation', { startedAt: AT, actorRoles: [] }]]).impersonation).to.deep.eq({ startedAt: new Date(AT), actorRoles: [] });
    const bad: unknown[] = [null, 'x', [], { startedAt: 'nope' }, { startedAt: 5 }, { startedAt: AT, actorRoles: 'user' }, { startedAt: AT, actorRoles: [42] }, { startedAt: AT, actorRoles: [''] }, { startedAt: AT, actorRoles: ['a', 'b'] }, { startedAt: AT, actorRoles: null }];
    for (const b of bad) expect(session([['Impersonation', b]]).impersonation, JSON.stringify(b)).to.eq(null);
  });

  it('Ip, UserAgent and PendingSteps', () => {
    const s = session([['Ip', '203.0.113.5'], ['UserAgent', 'kit'], ['authn:pendingSteps', ['totp']]], 'pending');
    expect([s.ip, s.userAgent, s.pendingSteps]).to.deep.eq(['203.0.113.5', 'kit', ['totp']]);
    expect(Object.isFrozen(s.pendingSteps)).to.eq(true);
    expect(session([['Ip', '']]).ip).to.eq(undefined);
    expect(session([['authn:pendingSteps', []]]).pendingSteps).to.eq(undefined);
    expect(session([['authn:pendingSteps', ['totp', 1]]]).pendingSteps).to.eq(undefined);
  });

  it('SessionKeys is frozen and names the stored keys', () => {
    expect(Object.isFrozen(SessionKeys)).to.eq(true);
    expect(Object.isFrozen(SessionKeys.ActiveRole)).to.eq(true);
    expect(Object.values(SessionKeys).map((k) => k.name)).to.deep.eq(['ActiveRole', 'Impersonation', 'Ip', 'UserAgent', 'authn:pendingSteps']);
  });
});
