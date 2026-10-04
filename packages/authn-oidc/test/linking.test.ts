import 'mocha';
import { expect } from 'chai';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';

import { flowCookieName } from '../src/flow/cookie.js';
import { OidcLogin, OIDC_FAILURE_BODY } from '../src/login.js';
import { ENV, world } from './support/world.js';

type World = Awaited<ReturnType<typeof world>>;

const FLOW = flowCookieName(ENV);

async function sessionOf(w: World, id: IdentityRef, ageSeconds = 0, pending = false): Promise<SessionHandle> {
  const facts = { method: 'password', strategy: 'local', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(Date.now() - ageSeconds * 1000) };
  return w.sessions.issue(id, facts, pending ? { pending: { steps: ['totp'] } } : undefined);
}

/** beginLink as `session`, play the IdP for `sub`, then call back with `back` (default: the same session). */
async function linkRound(w: World, session: SessionHandle | null, sub: string, back: SessionHandle | null = session, navigation = false) {
  const begun = await w.login.beginLink('corp', { ...w.request(), session });
  if (begun.status !== 302) return { begun, done: begun };
  const query = w.idp.authorize(begun.location!, { claims: { sub } });
  const done = await w.login.callback('corp', { ...w.request(query, { [FLOW]: w.flowOf(begun) }, navigation), session: back });
  return { begun, query, done };
}

describe('authn-oidc linking (A19)', () => {
  it('a first login of an unlinked subject fails with not_linked while JIT is off', async () => {
    const w = await world();
    w.identities.add({ login: 'alice@example.test', email: 'alice@example.test' });
    const { done } = await w.roundTrip({ claims: { sub: 'kc-new', email: 'alice@example.test', email_verified: true } });
    expect(done).to.deep.include({ status: 401, body: OIDC_FAILURE_BODY });
    expect(w.events.all().some((e) => e.type === 'login' && e.outcome === 'failure' && e.reason === 'not_linked')).to.eq(true);
  });

  it('links from a fresh session, after which the subject logs in to that identity', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice@example.test' });
    const session = await sessionOf(w, alice);
    const { begun, done } = await linkRound(w, session, 'kc-9');
    expect(begun.status).to.eq(302);
    expect(done).to.deep.include({ status: 303, location: '/home' });
    expect((await w.links.find('oidc:corp', 'kc-9'))?.identity).to.deep.eq(alice);
    expect(w.hook.calls).to.have.length(0);

    const login = await w.roundTrip({ claims: { sub: 'kc-9' } });
    expect(login.done.status).to.eq(303);
    const cookie = login.done.cookies.find((c) => c.Name === 'ssid')!;
    expect((await w.sessions.restore(cookie.Value))?.identity).to.deep.eq(alice);
  });

  it('refuses a stale or pending session and writes nothing', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice@example.test' });
    expect((await linkRound(w, await sessionOf(w, alice, 301), 'kc-9')).done.status).to.eq(401);
    expect((await linkRound(w, await sessionOf(w, alice, 0, true), 'kc-9')).done.status).to.eq(401);
    expect((await linkRound(w, null, 'kc-9')).done.status).to.eq(401);
    expect(await w.links.find('oidc:corp', 'kc-9')).to.eq(null);
  });

  it('needs the session that started the flow to come back', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice@example.test' });
    const mallory = w.identities.add({ login: 'mallory@example.test' });
    const { done } = await linkRound(w, await sessionOf(w, alice), 'kc-9', await sessionOf(w, mallory));
    expect(done.status).to.eq(401);
    expect(await w.links.find('oidc:corp', 'kc-9')).to.eq(null);
  });

  it('refuses a subject linked to another identity, which keeps it', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice@example.test' });
    const bob = w.identities.add({ login: 'bob@example.test' });
    await w.links.link(bob, { provider: 'oidc:corp', subject: 'kc-bob' });
    expect((await linkRound(w, await sessionOf(w, alice), 'kc-bob')).done.status).to.eq(401);
    expect((await w.links.find('oidc:corp', 'kc-bob'))?.identity).to.deep.eq(bob);
  });

  it('never lets a link callback through the login path, nor a login callback link', async () => {
    const w = await world();
    const alice = w.identities.add({ login: 'alice@example.test' });
    const session = await sessionOf(w, alice);
    // A login flow's callback while a session is present still logs in (or fails); it never links.
    const { done } = await w.roundTrip({ claims: { sub: 'kc-unlinked' } });
    expect(done.status).to.eq(401);
    expect(await w.links.find('oidc:corp', 'kc-unlinked')).to.eq(null);
    expect(w.linker.calls).to.deep.eq([]);
    expect(session.state).to.eq('active');
  });

  describe('unlink', () => {
    const unlink = (w: World, session: SessionHandle | null) => w.login.unlink('corp', { ...w.request(), session });

    it('refuses to remove the last usable credential', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      const a = await unlink(w, await sessionOf(w, alice));
      expect(a.status).to.eq(403);
      expect((await w.links.find('oidc:corp', 'kc-1'))?.identity).to.deep.eq(alice);
    });

    it('removes the link when a password remains', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      w.linker.withPassword.add(alice.id);
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      expect((await unlink(w, await sessionOf(w, alice))).status).to.eq(204);
      expect(await w.links.find('oidc:corp', 'kc-1')).to.eq(null);
    });

    it('answers 404 without a link of that provider, and 401 without an active session', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      expect((await unlink(w, await sessionOf(w, alice))).status).to.eq(404);
      expect((await unlink(w, null)).status).to.eq(401);
      expect((await unlink(w, await sessionOf(w, alice, 0, true))).status).to.eq(401);
    });
  });

  it('answers 404 on the link routes when no OidcAccountLinks is registered', async () => {
    const w = await world();
    const bare = new OidcLogin({ ...(w.login as unknown as { d: ConstructorParameters<typeof OidcLogin>[0] }).d, linker: null });
    const alice = w.identities.add({ login: 'alice@example.test' });
    expect((await bare.beginLink('corp', { ...w.request(), session: await sessionOf(w, alice) })).status).to.eq(404);
    expect((await bare.unlink('corp', { ...w.request(), session: await sessionOf(w, alice) })).status).to.eq(404);
  });

  describe('browser navigation (SameSite=Strict session cookie)', () => {
    it('a link callback that arrives without the session cookie hops once same-site, consuming nothing', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      const session = await sessionOf(w, alice);
      const { begun, query, done } = await linkRound(w, session, 'kc-9', null, true);
      expect(done.status).to.eq(200);
      expect(done.cookies).to.deep.eq([]);
      const target = /url=([^"]+)"/.exec(done.html!)![1].replace(/&#38;/g, '&');
      expect(target.startsWith('/auth/oidc/corp/callback?')).to.eq(true);
      const again = Object.fromEntries(new URLSearchParams(target.split('?')[1]));
      expect(again).to.deep.eq({ ...query, bounce: '1' });

      const second = await w.login.callback('corp', { ...w.request(again, { [FLOW]: w.flowOf(begun) }, true), session });
      expect(second.status).to.eq(200);
      expect(second.html).to.contain('url=/home');
      expect((await w.links.find('oidc:corp', 'kc-9'))?.identity).to.deep.eq(alice);
    });

    it('does not hop twice', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      const { begun, query } = await linkRound(w, await sessionOf(w, alice), 'kc-9', null, true);
      const second = await w.login.callback('corp', { ...w.request({ ...query, bounce: '1' }, { [FLOW]: w.flowOf(begun) }, true), session: null });
      expect(second).to.deep.include({ status: 303, location: '/login' });
    });

    it('a login ends on a same-site page that moves on to the escaped returnTo', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      const { done } = await w.roundTrip({ claims: { sub: 'kc-1' } }, { returnTo: '/after?a=1&b="x"', navigation: true });
      expect(done.status).to.eq(200);
      expect(done.cookies.map((c) => c.Name)).to.deep.eq([FLOW, 'ssid']);
      expect(done.html).to.contain('url=/after?a=1&#38;b=&#34;x&#34;"');
      expect(done.html).to.not.contain('"x"');
    });
  });
});
