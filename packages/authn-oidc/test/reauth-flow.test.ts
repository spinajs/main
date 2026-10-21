import 'mocha';
import { expect } from 'chai';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn/contracts';
import type { Credentials, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';

import { decodeFlow, encodeFlow, flowCookieName, sessionBindingOf } from '../src/flow/cookie.js';
import type { OidcFlow } from '../src/flow/cookie.js';
import { ENV, ORIGIN, world } from './support/world.js';
import type { WorldOptions } from './support/world.js';

type World = Awaited<ReturnType<typeof world>>;

const FLOW = flowCookieName(ENV);
const STALE_SECONDS = 400;

async function sessionOf(w: World, id: IdentityRef, opts: { ageSeconds?: number; pending?: boolean; assurance?: 'aal1' | 'aal2' } = {}): Promise<SessionHandle> {
  const facts = { method: 'password', strategy: 'local', assurance: opts.assurance ?? ('aal1' as const), mfa: opts.assurance === 'aal2' ? ['totp'] : [], authenticatedAt: new Date(Date.now() - (opts.ageSeconds ?? STALE_SECONDS) * 1000) };
  return w.sessions.issue(id, facts, opts.pending ? { pending: { steps: ['totp'] } } : undefined);
}

interface RoundOptions {
  /** The session the callback arrives with; default the one that started the flow. */
  readonly back?: SessionHandle | null;
  readonly navigation?: boolean;
  readonly returnTo?: string;
  /** Merged into the ID token claims. */
  readonly override?: Readonly<Record<string, unknown>>;
}

/** beginReauth as `session`, play the IdP for `sub`, then call back. */
async function reauthRound(w: World, session: SessionHandle | null, sub: string, o: RoundOptions = {}) {
  const begun = await w.login.beginReauth('corp', { ...w.request(o.returnTo !== undefined ? { returnTo: o.returnTo } : {}), session });
  if (begun.status !== 302) return { begun, done: begun, flow: null };
  const flow = decodeFlow(w.flowOf(begun))!;
  const query = w.idp.authorize(begun.location!, { claims: { sub }, ...(o.override ? { override: o.override } : {}) });
  const done = await w.login.callback('corp', { ...w.request(query, { [FLOW]: w.flowOf(begun) }, o.navigation ?? false), session: o.back === undefined ? session : o.back });
  return { begun, query, done, flow };
}

async function aliceWorld(o: WorldOptions = {}) {
  const w = await world(o);
  const alice = w.identities.add({ login: 'alice@example.test' });
  await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
  return { w, alice };
}

const sessionCookieOf = (cookies: readonly { Name: string; Value: string }[]) => cookies.find((c) => c.Name === 'ssid');

describe('authn-oidc re-authentication (FLOW-4)', () => {
  describe('the authorization request', () => {
    it('asks the provider for a new login with prompt=login and max_age=0, over a configured prompt', async () => {
      const { w, alice } = await aliceWorld({ provider: { authorizationParams: { prompt: 'select_account' } } });
      const session = await sessionOf(w, alice);
      const begun = await w.login.beginReauth('corp', { ...w.request(), session });
      expect(begun.status).to.eq(302);
      const u = new URL(begun.location!);
      expect(u.searchParams.get('prompt')).to.eq('login');
      expect(u.searchParams.get('max_age')).to.eq('0');
      expect(u.searchParams.get('response_type')).to.eq('code');
      expect(u.searchParams.get('code_challenge_method')).to.eq('S256');
      const flow = decodeFlow(w.flowOf(begun));
      expect(flow).to.deep.include({ m: 'reauth', h: sessionBindingOf(session.id) });
    });

    it('a login still sends no max_age and keeps the configured prompt', async () => {
      const { w } = await aliceWorld({ provider: { authorizationParams: { prompt: 'select_account' } } });
      const u = new URL((await w.login.begin('corp', w.request())).location!);
      expect(u.searchParams.has('max_age')).to.eq(false);
      expect(u.searchParams.get('prompt')).to.eq('select_account');
    });

    it('refuses to start without an active session and sets no flow cookie', async () => {
      const { w, alice } = await aliceWorld();
      for (const session of [null, await sessionOf(w, alice, { pending: true })]) {
        const a = await w.login.beginReauth('corp', { ...w.request(), session });
        expect(a).to.deep.include({ status: 401, body: AUTHN_FAILURE_BODY });
        expect(a.cookies.every((c) => c.Value === '')).to.eq(true);
      }
      const browser = await w.login.beginReauth('corp', { ...w.request({}, {}, true), session: null });
      expect(browser).to.deep.include({ status: 303, location: '/login' });
    });

    it('answers the failure for an unknown provider', async () => {
      const { w, alice } = await aliceWorld();
      expect((await w.login.beginReauth('nope', { ...w.request(), session: await sessionOf(w, alice) })).status).to.eq(401);
    });
  });

  describe('the flow cookie', () => {
    const base = (): OidcFlow => ({ v: 1, p: 'corp', s: 'A'.repeat(43), t: Math.floor(Date.now() / 1000), r: '/after', u: `${ORIGIN}/auth/oidc/corp/callback`, m: 'reauth', h: sessionBindingOf('raw-session') });

    it('a reauth flow keeps its returnTo and needs its session binding', () => {
      expect(decodeFlow(encodeFlow(base()))).to.deep.include({ m: 'reauth', r: '/after' });
      const { h: _h, ...unbound } = base();
      expect(decodeFlow(encodeFlow(unbound))).to.eq(null);
      expect(decodeFlow(encodeFlow({ ...base(), m: 'login' }))).to.eq(null);
    });
  });

  describe('the callback', () => {
    it('moves the session to a new id with a fresh authenticatedAt, keeping identity, assurance and data; 303 to returnTo', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice, { assurance: 'aal2' });
      await w.sessions.set(session, 'ActiveRole', 'editor');
      const before = (await w.sessions.restore(session.id))!.facts.authenticatedAt;
      const started = Date.now();

      const { done } = await reauthRound(w, session, 'kc-1', { returnTo: '/after' });
      expect(done).to.deep.include({ status: 303, location: '/after' });
      expect(done.cookies.map((c) => c.Name)).to.deep.eq([FLOW, 'ssid']);
      expect(done.cookies[0].Value).to.eq('');
      const next = sessionCookieOf(done.cookies)!.Value;
      expect(next).to.not.eq(session.id);

      expect(await w.sessions.restore(session.id)).to.eq(null);
      const now = (await w.sessions.restore(next))!;
      expect(now.identity).to.deep.eq(alice);
      expect(now.handle.state).to.eq('active');
      expect(now.facts.authenticatedAt.getTime()).to.be.at.least(started);
      expect(now.facts.authenticatedAt.getTime()).to.be.greaterThan(before.getTime());
      expect(now.facts.assurance).to.eq('aal2');
      expect([...now.facts.mfa]).to.deep.eq(['totp']);
      expect(now.data.get('ActiveRole')).to.eq('editor');
      expect(w.events.all().some((e) => e.type === 'reauth' && e.outcome === 'success')).to.eq(true);
      expect(w.hook.calls, 'a re-authentication is no login').to.have.length(0);
    });

    it('lands on the success page without a returnTo, and a browser gets the same-site refresh page', async () => {
      const { w, alice } = await aliceWorld();
      expect((await reauthRound(w, await sessionOf(w, alice), 'kc-1')).done).to.deep.include({ status: 303, location: '/home' });
      const { done } = await reauthRound(w, await sessionOf(w, alice), 'kc-1', { returnTo: '/after', navigation: true });
      expect(done.status).to.eq(200);
      expect(done.html).to.contain('url=/after');
      expect(sessionCookieOf(done.cookies)?.Value).to.be.a('string').and.not.eq('');
    });

    it('refuses an auth_time before the flow start minus the clock skew and leaves the session as it was', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice);
      const before = await w.sessions.restore(session.id);
      const skew = w.options.clockSkewSeconds;
      const begun = await w.login.beginReauth('corp', { ...w.request(), session });
      const flow = decodeFlow(w.flowOf(begun))!;
      const query = w.idp.authorize(begun.location!, { claims: { sub: 'kc-1' }, override: { auth_time: flow.t - skew - 1 } });
      const done = await w.login.callback('corp', { ...w.request(query, { [FLOW]: w.flowOf(begun) }), session });
      expect(done).to.deep.include({ status: 401, body: AUTHN_FAILURE_BODY });
      expect(sessionCookieOf(done.cookies)).to.eq(undefined);
      expect((await w.sessions.restore(session.id))?.facts).to.deep.eq(before?.facts);
    });

    it('takes an auth_time at the flow start minus the clock skew', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice);
      const begun = await w.login.beginReauth('corp', { ...w.request(), session });
      const flow = decodeFlow(w.flowOf(begun))!;
      const query = w.idp.authorize(begun.location!, { claims: { sub: 'kc-1' }, override: { auth_time: flow.t - w.options.clockSkewSeconds } });
      expect((await w.login.callback('corp', { ...w.request(query, { [FLOW]: w.flowOf(begun) }), session })).status).to.eq(303);
    });

    it('refuses an ID token without auth_time', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice);
      const { done } = await reauthRound(w, session, 'kc-1', { override: { auth_time: undefined } });
      expect(done.status).to.eq(401);
      expect(await w.sessions.restore(session.id)).to.not.eq(null);
    });

    it('refuses a subject linked to another identity and leaves the session as it was', async () => {
      const { w, alice } = await aliceWorld();
      const bob = w.identities.add({ login: 'bob@example.test' });
      await w.links.link(bob, { provider: 'oidc:corp', subject: 'kc-bob' });
      const session = await sessionOf(w, alice);
      const before = await w.sessions.restore(session.id);
      const { done } = await reauthRound(w, session, 'kc-bob');
      expect(done).to.deep.include({ status: 401, body: AUTHN_FAILURE_BODY });
      expect(sessionCookieOf(done.cookies)).to.eq(undefined);
      const after = await w.sessions.restore(session.id);
      expect(after?.identity).to.deep.eq(alice);
      expect(after?.facts).to.deep.eq(before?.facts);
      expect(w.events.all().some((e) => e.type === 'reauth' && e.outcome === 'failure')).to.eq(true);
    });

    it('refuses an unlinked subject and provisions or links nothing, JIT on or not', async () => {
      const { w, alice } = await aliceWorld({ linking: { jit: true, byVerifiedEmail: false }, provider: { linking: { jit: true } } });
      const session = await sessionOf(w, alice);
      const { done } = await reauthRound(w, session, 'kc-new');
      expect(done.status).to.eq(401);
      expect(await w.links.find('oidc:corp', 'kc-new')).to.eq(null);
      expect(await w.sessions.restore(session.id)).to.not.eq(null);
    });

    it('needs the session that started the flow to come back', async () => {
      const { w, alice } = await aliceWorld();
      const first = await sessionOf(w, alice);
      const second = await sessionOf(w, alice);
      const { done } = await reauthRound(w, first, 'kc-1', { back: second });
      expect(done.status).to.eq(401);
      expect(await w.sessions.restore(first.id)).to.not.eq(null);
      expect(await w.sessions.restore(second.id)).to.not.eq(null);
    });

    it('a reauth callback without a session logs nobody in', async () => {
      const { w, alice } = await aliceWorld();
      const { done } = await reauthRound(w, await sessionOf(w, alice), 'kc-1', { back: null });
      expect(done).to.deep.include({ status: 401, body: AUTHN_FAILURE_BODY });
      expect(sessionCookieOf(done.cookies)).to.eq(undefined);
    });

    it('AuthnService.authenticate never logs in with a reauth flow', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice);
      const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, mode: 'reauth', sessionHash: sessionBindingOf(session.id), now: new Date() });
      const credentials: Credentials = { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: w.idp.authorize(location, { claims: { sub: 'kc-1' } }) } };
      const r = await w.service.authenticate(credentials, { ...w.ctx(), purpose: 'login' });
      expect(r.status).to.eq('failure');
    });

    it('a navigation without the session cookie hops once same-site, then re-authenticates', async () => {
      const { w, alice } = await aliceWorld();
      const session = await sessionOf(w, alice);
      const begun = await w.login.beginReauth('corp', { ...w.request({ returnTo: '/after' }), session });
      const query = w.idp.authorize(begun.location!, { claims: { sub: 'kc-1' } });
      const hop = await w.login.callback('corp', { ...w.request(query, { [FLOW]: w.flowOf(begun) }, true), session: null });
      expect(hop.status).to.eq(200);
      expect(hop.cookies).to.deep.eq([]);
      const target = /url=([^"]+)"/.exec(hop.html!)![1].replace(/&#38;/g, '&');
      expect(target.startsWith('/auth/oidc/corp/callback?')).to.eq(true);
      const again = Object.fromEntries(new URLSearchParams(target.split('?')[1]));
      expect(again).to.deep.eq({ ...query, bounce: '1' });

      const done = await w.login.callback('corp', { ...w.request(again, { [FLOW]: w.flowOf(begun) }, true), session });
      expect(done.status).to.eq(200);
      expect(done.html).to.contain('url=/after');
      expect(await w.sessions.restore(session.id)).to.eq(null);
    });
  });
});
