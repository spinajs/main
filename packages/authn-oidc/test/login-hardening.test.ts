import 'mocha';
import { expect } from 'chai';
import type { Credentials, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';

import { encodeFlow, flowCookieName } from '../src/flow/cookie.js';
import { OidcStrategy } from '../src/strategy.js';
import { ENV, ORIGIN, world } from './support/world.js';

type World = Awaited<ReturnType<typeof world>>;
const FLOW = flowCookieName(ENV);

async function sessionOf(w: World, id: IdentityRef): Promise<SessionHandle> {
  return w.sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
}

describe('authn-oidc login hardening', () => {
  describe('per-provider linking switches against the core (D5)', () => {
    it('never provisions with the provider jit off, even when email matching finds nobody', async () => {
      const w = await world({ linking: { jit: true, byVerifiedEmail: false }, provider: { linking: { jit: false, byVerifiedEmail: true } } });
      w.identities.add({ login: 'alice@example.test', email: 'alice@example.test' });
      const { done } = await w.roundTrip({ claims: { sub: 'new', email: 'alice@example.test', email_verified: true } });
      expect(done.status).to.eq(401);
      expect(w.identities.calls.provision).to.have.length(0);
    });

    it('links by email only to the identity whose stored email equals it, not to a login name', async () => {
      const w = await world({ linking: { jit: true, byVerifiedEmail: true }, provider: { linking: { byVerifiedEmail: true } } });
      w.identities.add({ login: 'alice@example.test', email: 'someone-else@example.test' });
      const { done } = await w.roundTrip({ claims: { sub: 'new', email: 'alice@example.test', email_verified: true } });
      expect(done.status).to.eq(401);
      expect(w.identities.calls.provision).to.have.length(0);
    });

    it('links by a verified stored email when both switches are on, ignoring ASCII case', async () => {
      const w = await world({ linking: { jit: false, byVerifiedEmail: true }, provider: { linking: { byVerifiedEmail: true } } });
      const alice = w.identities.add({ login: 'alice', email: 'Alice@Example.test' });
      const { done } = await w.roundTrip({ claims: { sub: 'new', email: 'alice@example.test', email_verified: true } });
      expect(done.status).to.eq(303);
      expect((await w.links.find('oidc:corp', 'new'))?.identity).to.deep.eq(alice);
    });

    it('refuses email matching with the global switch off', async () => {
      const w = await world({ linking: { jit: false, byVerifiedEmail: false }, provider: { linking: { byVerifiedEmail: true } } });
      w.identities.add({ login: 'alice', email: 'alice@example.test' });
      expect((await w.roundTrip({ claims: { sub: 'new', email: 'alice@example.test', email_verified: true } })).done.status).to.eq(401);
    });
  });

  it('takes the email and its verified flag from one document', async () => {
    const w = await world({ linking: { jit: false, byVerifiedEmail: true }, provider: { linking: { byVerifiedEmail: true } } });
    w.identities.add({ login: 'victim', email: 'victim@example.test' });
    // The ID token says some email is verified but names none; userinfo names the victim's.
    const { done } = await w.roundTrip({ claims: { sub: 'attacker' }, override: { email_verified: true }, userinfo: { email: 'victim@example.test' } });
    expect(done.status).to.eq(401);
  });

  it('a throttled callback carries Retry-After', async () => {
    const w = await world({ throttle: { login: { ip: { free: 0, baseDelayMs: 5000, maxDelayMs: 5000 } } } });
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
    await w.roundTrip({ claims: { sub: 'kc-1' } });
    const { done } = await w.roundTrip({ claims: { sub: 'kc-1' } });
    expect(done.status).to.eq(401);
    expect(done.headers?.['retry-after']).to.match(/^[1-9][0-9]*$/);
  });

  it('hands the verified subject over between strategy instances of one provider only', async () => {
    const w = await world();
    await w.links.link({ type: 'user', id: 'u-1' }, { provider: 'oidc:corp', subject: 'kc-1' });
    const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/cb`, now: new Date(), mode: 'login' });
    const c: Credentials = { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: w.idp.authorize(location, { claims: { sub: 'kc-1' } }) } };
    const other = new OidcStrategy({ provider: w.provider, links: w.links });
    expect((await other.verify(c, w.ctx())).ok).to.eq(true);
    expect(w.strategy.verified(c)?.subject).to.eq('kc-1');
    const elsewhere = await world({ name: 'other' });
    expect(elsewhere.strategy.verified(c)).to.eq(undefined);
  });

  it('starts a link flow only same-origin or from the address bar', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice' });
    const session = await sessionOf(w, alice);
    for (const fetchSite of ['cross-site', 'same-site']) {
      expect((await w.login.beginLink('corp', { ...w.request(), session, fetchSite })).status, fetchSite).to.eq(401);
    }
    for (const fetchSite of ['same-origin', 'none', undefined]) {
      expect((await w.login.beginLink('corp', { ...w.request(), session, ...(fetchSite ? { fetchSite } : {}) })).status, String(fetchSite)).to.eq(302);
    }
  });

  it('hops same-site only for a callback whose state belongs to the flow cookie', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice' });
    const begun = await w.login.beginLink('corp', { ...w.request(), session: await sessionOf(w, alice) });
    const query = w.idp.authorize(begun.location!, { claims: { sub: 'kc-9' } });
    const forged = await w.login.callback('corp', { ...w.request({ ...query, state: 'forged' }, { [FLOW]: w.flowOf(begun) }, true), session: null });
    expect(forged).to.deep.include({ status: 303, location: '/login' });
  });

  it('unlinks one of several subjects of a provider only when the request names it', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice' });
    w.linker.withPassword.add(alice.id);
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'a' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'b' });
    const session = await sessionOf(w, alice);
    expect((await w.login.unlink('corp', { ...w.request(), session })).status).to.eq(409);
    expect((await w.login.unlink('corp', { ...w.request({ subject: 'b' }), session })).status).to.eq(204);
    expect(await w.links.find('oidc:corp', 'b')).to.eq(null);
    expect(await w.links.find('oidc:corp', 'a')).to.not.eq(null);
  });

  it('a hook source that throws fails the login and revokes the session', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
    (w.login as unknown as { d: { hooks: () => never } }).d.hooks = () => {
      throw new Error('DI failed');
    };
    const { done } = await w.roundTrip({ claims: { sub: 'kc-1' } });
    expect(done.status).to.eq(401);
    expect(await w.sessions.storage.storedKeys()).to.deep.eq([]);
  });

  it('audits a login the hooks refuse, after the core audited its success', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
    w.hook.fail = true;
    expect((await w.roundTrip({ claims: { sub: 'kc-1' } })).done.status).to.eq(401);
    expect(w.audited).to.have.length(1);
    expect(w.audited[0]).to.deep.include({ type: 'login', outcome: 'failure', strategy: 'oidc:corp', reason: 'hook_error', identity: alice });
  });
});
