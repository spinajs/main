import 'mocha';
import { expect } from 'chai';
import type { Credentials } from '@spinajs/authn/contracts';

import { hasRequiredClaims, mapClaims, rawClaims, readClaim } from '../src/claims.js';
import { DEFAULT_CLAIMS, OIDC_PRESETS } from '../src/presets.js';
import { OIDC_FAILURE_BODY } from '../src/login.js';
import { flowCookieName } from '../src/flow/cookie.js';
import { FakeIdp } from './support/fake-idp.js';
import type { FakeLogin } from './support/fake-idp.js';
import { ENV, ORIGIN, SESSION_COOKIE, world } from './support/world.js';

async function rejects(p: Promise<unknown>, what?: string): Promise<Error> {
  try {
    await p;
  } catch (err) {
    if (what) expect((err as Error).message).to.contain(what);
    return err as Error;
  }
  return expect.fail('expected a rejection');
}

describe('authn-oidc login', () => {
  describe('claims mapping', () => {
    const raw = { sub: 's-1', email: 'a@example.test', email_verified: true, name: 'Alice', groups: ['eng', 42, 'ops'], 'https://corp/roles': 'admin', realm_access: { roles: ['r1'] } };

    it('reads top-level names (dots included) and nested paths, own properties only', () => {
      expect(readClaim(raw, 'https://corp/roles')).to.eq('admin');
      expect(readClaim(raw, ['realm_access', 'roles'])).to.deep.eq(['r1']);
      expect(readClaim(raw, ['realm_access', 'missing'])).to.eq(undefined);
      expect(readClaim(raw, 'toString')).to.eq(undefined);
      expect(readClaim(raw, ['name', 'length'])).to.eq(undefined);
    });

    it('maps subject, email, verified email, name and groups', () => {
      const s = mapClaims('oidc:corp', DEFAULT_CLAIMS, raw);
      expect(s).to.deep.eq({ provider: 'oidc:corp', subject: 's-1', email: 'a@example.test', emailVerified: true, claims: { name: 'Alice', groups: ['eng', 'ops'], raw } });
    });

    it('marks the email verified only for a boolean true', () => {
      for (const v of ['true', 1, undefined, false]) {
        expect(mapClaims('oidc:corp', DEFAULT_CLAIMS, { ...raw, email_verified: v }).emailVerified, String(v)).to.eq(false);
      }
      expect(mapClaims('oidc:corp', { ...DEFAULT_CLAIMS, emailVerified: null }, raw).emailVerified).to.eq(false);
    });

    it('takes one string as one group, and leaves groups absent when unmapped or missing', () => {
      expect(mapClaims('oidc:corp', DEFAULT_CLAIMS, { ...raw, groups: 'eng' }).claims.groups).to.deep.eq(['eng']);
      expect(mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: 's' }).claims).to.not.have.property('groups');
      expect(mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: 's', groups: {} }).claims).to.not.have.property('groups');
      expect(mapClaims('oidc:corp', { ...DEFAULT_CLAIMS, groups: null }, raw).claims).to.not.have.property('groups');
      expect(mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: 's', groups: [] }).claims.groups).to.deep.eq([]);
    });

    it("turns GitHub's numeric id into its decimal string and refuses a missing subject", () => {
      expect(mapClaims('oidc:gh', OIDC_PRESETS.github.claims, { id: 583231, login: 'octocat' }).subject).to.eq('583231');
      expect(() => mapClaims('oidc:corp', DEFAULT_CLAIMS, { email: 'a@example.test' })).to.throw();
      expect(() => mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: '' })).to.throw();
      expect(() => mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: 1.5 })).to.throw();
      expect(() => mapClaims('oidc:corp', DEFAULT_CLAIMS, { sub: 'x'.repeat(256) })).to.throw();
    });

    it('keeps the ID token claims over userinfo, and a __proto__ member stays a plain member', () => {
      const userinfo = JSON.parse('{"sub":"other","email":"u@example.test","__proto__":{"polluted":true}}') as Record<string, unknown>;
      const merged = rawClaims({ sub: 's-1' }, userinfo);
      expect(merged.sub).to.eq('s-1');
      expect(merged.email).to.eq('u@example.test');
      expect(({} as Record<string, unknown>).polluted).to.eq(undefined);
      expect((merged as Record<string, unknown>).polluted).to.eq(undefined);
    });

    it('checks required claims by exact value', () => {
      expect(hasRequiredClaims({ hd: 'example.com', tier: 2 }, { hd: 'example.com', tier: 2 })).to.eq(true);
      expect(hasRequiredClaims({ hd: 'example.com' }, { hd: 'evil.com' })).to.eq(false);
      expect(hasRequiredClaims({ tier: '2' }, { tier: 2 })).to.eq(false);
      expect(hasRequiredClaims({}, { hd: 'example.com' })).to.eq(false);
    });
  });

  describe('provider callback', () => {
    it('begins with a code request that holds the redirect URI on the request origin', async () => {
      const w = await world();
      const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/auth/oidc/corp/callback`, now: new Date(), mode: 'login' });
      const u = new URL(location);
      expect(u.searchParams.get('redirect_uri')).to.eq(`${ORIGIN}/auth/oidc/corp/callback`);
      expect(flow.u).to.eq(`${ORIGIN}/auth/oidc/corp/callback`);
    });

    it('uses the configured redirectUri over the request origin', async () => {
      const w = await world({ provider: { redirectUri: 'https://fixed.example.test/cb' } });
      const { location } = await w.provider.begin({ redirectUri: `${ORIGIN}/x`, now: new Date(), mode: 'login' });
      expect(new URL(location).searchParams.get('redirect_uri')).to.eq('https://fixed.example.test/cb');
    });

    const complete = async (w: Awaited<ReturnType<typeof world>>, change: (q: Record<string, string>) => Record<string, string> = (q) => q, login: FakeLogin = { claims: { sub: 'kc-1', email: 'a@example.test', email_verified: true } }) => {
      const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/cb`, now: new Date(), mode: 'login' });
      return { flow, query: change(w.idp.authorize(location, login)) };
    };

    it('completes a login into the mapped subject', async () => {
      const w = await world();
      const { flow, query } = await complete(w);
      const s = await w.provider.complete(flow, query, new Date());
      expect(s).to.deep.include({ provider: 'oidc:corp', subject: 'kc-1', email: 'a@example.test', emailVerified: true });
      expect(s.claims.raw).to.have.property('iss', w.idp.issuer);
    });

    it('refuses a wrong state, a replayed state, another provider, an expired flow, an error answer and a missing code', async () => {
      const w = await world();
      let c = await complete(w, (q) => ({ ...q, state: `${q.state}x` }));
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'state');
      c = await complete(w);
      await w.provider.complete(c.flow, c.query, new Date());
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'state already used');
      c = await complete(w);
      await rejects(w.provider.complete({ ...c.flow, p: 'other' }, c.query, new Date()), 'another provider');
      c = await complete(w);
      await rejects(w.provider.complete(c.flow, c.query, new Date(Date.now() + 601_000)), 'expired');
      c = await complete(w, (q) => ({ state: q.state, error: 'access_denied' }));
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'error');
      c = await complete(w, (q) => ({ state: q.state }));
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'code');
    });

    it('claims the state before any network call, so a failed exchange still burns it', async () => {
      const w = await world();
      const c = await complete(w);
      w.idp.fail(w.idp.tokenUrl);
      await rejects(w.provider.complete(c.flow, c.query, new Date()));
      w.idp.restore(w.idp.tokenUrl);
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'state already used');
    });

    it('checks the RFC 9207 iss parameter when sent, and needs it when advertised', async () => {
      const w = await world();
      let c = await complete(w, (q) => ({ ...q, iss: 'https://evil.example.test' }));
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'iss');
      c = await complete(w, (q) => ({ ...q, iss: w.idp.issuer }));
      expect((await w.provider.complete(c.flow, c.query, new Date())).subject).to.eq('kc-1');

      const idp = await FakeIdp.create();
      idp.discovery.authorization_response_iss_parameter_supported = true;
      const v = await world({ idp });
      c = await complete(v);
      await rejects(v.provider.complete(c.flow, c.query, new Date()), 'iss missing');
      c = await complete(v, (q) => ({ ...q, iss: idp.issuer }));
      expect((await v.provider.complete(c.flow, c.query, new Date())).subject).to.eq('kc-1');
    });

    it('needs the userinfo sub to equal the ID token sub, and skips userinfo when turned off', async () => {
      const w = await world();
      let c = await complete(w, undefined, { claims: { sub: 'kc-1' }, userinfo: { sub: 'kc-2' } } );
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'userinfo sub');
      const off = await world({ provider: { userinfo: false } });
      c = await complete(off, undefined, { claims: { sub: 'kc-1' }, userinfo: { sub: 'kc-2' } } );
      expect((await off.provider.complete(c.flow, c.query, new Date())).subject).to.eq('kc-1');
      expect(off.idp.count(off.idp.userinfoUrl)).to.eq(0);
    });

    it('fails when userinfo is on but the provider has no endpoint', async () => {
      const idp = await FakeIdp.create();
      delete idp.discovery.userinfo_endpoint;
      const w = await world({ idp, provider: { userinfo: true } });
      const c = await complete(w);
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'userinfo');
    });

    it('refuses a login without the required claims', async () => {
      const w = await world({ provider: { requiredClaims: { hd: 'example.com' } } });
      let c = await complete(w, undefined, { claims: { sub: 'kc-1', hd: 'evil.com' } });
      await rejects(w.provider.complete(c.flow, c.query, new Date()), 'required');
      c = await complete(w, undefined, { claims: { sub: 'kc-1', hd: 'example.com' } });
      expect((await w.provider.complete(c.flow, c.query, new Date())).subject).to.eq('kc-1');
    });
  });

  describe('strategy', () => {
    it("is 'oidc:<name>', external, interactive, and accepts only its provider's credentials", async () => {
      const w = await world();
      expect(w.strategy.name).to.eq('oidc:corp');
      expect(w.strategy.kinds).to.deep.eq(['external']);
      expect(w.strategy.interactive).to.eq(true);
      expect(w.strategy.accepts({ kind: 'external', provider: 'oidc:corp', payload: {} })).to.eq(true);
      expect(w.strategy.accepts({ kind: 'external', provider: 'oidc:other', payload: {} })).to.eq(false);
      expect(w.strategy.accepts({ kind: 'password', login: 'a', password: 'b' })).to.eq(false);
      expect(w.strategy.throttleKeys()).to.deep.eq([]);
    });

    it('answers unsupported for foreign or malformed credentials, and a failure for a bad callback', async () => {
      const w = await world();
      const ctx = w.ctx();
      expect(await w.strategy.verify({ kind: 'password', login: 'a', password: 'b' }, ctx)).to.deep.eq({ ok: false, reason: 'unsupported_credentials' });
      expect(await w.strategy.verify({ kind: 'external', provider: 'oidc:corp', payload: { flow: 'x', query: { code: ['a'] } } }, ctx)).to.deep.eq({ ok: false, reason: 'unsupported_credentials' });
      expect(await w.strategy.verify({ kind: 'external', provider: 'oidc:corp', payload: { flow: 'x', query: {} } }, ctx)).to.deep.eq({ ok: false, reason: 'invalid_credentials' });
    });

    const credentialsFor = async (w: Awaited<ReturnType<typeof world>>, claims: Record<string, unknown>): Promise<Credentials> => {
      const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/cb`, now: new Date(), mode: 'login' });
      const { encodeFlow } = await import('../src/flow/cookie.js');
      return { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: w.idp.authorize(location, { claims }) } };
    };

    it('answers not_linked for an unlinked subject while the provider switches are off', async () => {
      const w = await world({ linking: { jit: true, byVerifiedEmail: true } });
      w.identities.add({ login: 'a@example.test', email: 'a@example.test' });
      expect(await w.strategy.verify(await credentialsFor(w, { sub: 'new', email: 'a@example.test', email_verified: true }), w.ctx())).to.deep.eq({ ok: false, reason: 'not_linked' });
    });

    it('passes a linked subject, and the verified email only with the provider switch on', async () => {
      const w = await world();
      await w.links.link({ type: 'user', id: 'u-1' }, { provider: 'oidc:corp', subject: 'kc-1' });
      const c = await credentialsFor(w, { sub: 'kc-1', email: 'a@example.test', email_verified: true });
      const out = await w.strategy.verify(c, w.ctx());
      expect(out).to.deep.include({ ok: true, method: 'oidc' });
      expect(out.ok && out.external).to.deep.include({ subject: 'kc-1', emailVerified: false });
    });

    it("gives the core this provider's own linking switches, and none for another provider (K6)", async () => {
      const w = await world({ provider: { linking: { jit: true } }, linking: { jit: true, byVerifiedEmail: true } });
      expect(w.strategy.linkingFor({ provider: 'oidc:corp', subject: 's' })).to.deep.eq({ jit: true, byVerifiedEmail: false });
      expect(w.strategy.linkingFor({ provider: 'oidc:other', subject: 's' })).to.deep.eq({ jit: false, byVerifiedEmail: false });
    });

    it('passes an unlinked subject with the provider jit switch', async () => {
      const w = await world({ provider: { linking: { jit: true } }, linking: { jit: true, byVerifiedEmail: false } });
      const out = await w.strategy.verify(await credentialsFor(w, { sub: 'new' }), w.ctx());
      expect(out.ok).to.eq(true);
    });

    it('with byVerifiedEmail and no jit, passes only a verified email that names an identity', async () => {
      const w = await world({ provider: { linking: { byVerifiedEmail: true } }, linking: { jit: false, byVerifiedEmail: true } });
      w.identities.add({ login: 'a@example.test', email: 'a@example.test' });
      const ok = await w.strategy.verify(await credentialsFor(w, { sub: 'n1', email: 'a@example.test', email_verified: true }), w.ctx());
      expect(ok.ok && ok.external?.emailVerified).to.eq(true);
      expect(await w.strategy.verify(await credentialsFor(w, { sub: 'n2', email: 'b@example.test', email_verified: true }), w.ctx())).to.deep.eq({ ok: false, reason: 'not_linked' });
      expect(await w.strategy.verify(await credentialsFor(w, { sub: 'n3', email: 'a@example.test', email_verified: 'true' }), w.ctx())).to.deep.eq({ ok: false, reason: 'not_linked' });
    });

    it('never runs a link flow as a login', async () => {
      const w = await world();
      const { encodeFlow, sha256hex } = await import('../src/flow/cookie.js');
      const { flow, location } = await w.provider.begin({ redirectUri: `${ORIGIN}/cb`, now: new Date(), mode: 'link', sessionHash: sha256hex('s') });
      await w.links.link({ type: 'user', id: 'u-1' }, { provider: 'oidc:corp', subject: 'kc-1' });
      const c: Credentials = { kind: 'external', provider: 'oidc:corp', payload: { flow: encodeFlow(flow), query: w.idp.authorize(location, { claims: { sub: 'kc-1' } }) } };
      expect(await w.strategy.verify(c, w.ctx())).to.deep.eq({ ok: false, reason: 'invalid_credentials' });
    });
  });

  describe('login routes', () => {
    it('begin redirects to the provider and sets the flow cookie', async () => {
      const w = await world();
      const a = await w.login.begin('corp', w.request({ returnTo: '/after' }));
      expect(a.status).to.eq(302);
      expect(a.location).to.match(/^https:\/\/idp\.example\.test\//);
      expect(a.cookies.map((c) => c.Name)).to.deep.eq([flowCookieName(ENV)]);
    });

    it('a linked subject logs in: session cookie, flow cookie cleared, hooks get the mapped claims, groups included', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      const { done } = await w.roundTrip({ claims: { sub: 'kc-1', email: 'alice@example.test', name: 'Alice', groups: ['eng'] } }, { returnTo: '/after' });
      expect(done.status).to.eq(303);
      expect(done.location).to.eq('/after');
      const session = done.cookies.find((c) => c.Name === SESSION_COOKIE)!;
      expect(session.Value).to.be.a('string').and.not.eq('');
      expect(done.cookies.find((c) => c.Name === flowCookieName(ENV))!.Value).to.eq('');
      expect((await w.sessions.restore(session.Value))?.identity).to.deep.eq(alice);
      expect(w.hook.calls).to.have.length(1);
      const [identity, external] = w.hook.calls[0];
      expect(identity).to.deep.eq(alice);
      expect(external).to.deep.include({ provider: 'oidc:corp', subject: 'kc-1' });
      expect((external.claims as { groups?: string[] }).groups).to.deep.eq(['eng']);
    });

    it('goes to the success redirect without a returnTo', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      expect((await w.roundTrip({ claims: { sub: 'kc-1' } })).done.location).to.eq('/home');
    });

    it('an unlinked subject fails with the login failure answer while JIT is off', async () => {
      const w = await world();
      const { done } = await w.roundTrip({ claims: { sub: 'nobody' } });
      expect(done).to.deep.include({ status: 401, body: OIDC_FAILURE_BODY });
      expect(done.cookies.map((c) => [c.Name, c.Value])).to.deep.eq([[flowCookieName(ENV), '']]);
      expect(w.hook.calls).to.have.length(0);
    });

    it('JIT provisions only with the global and the provider switch on', async () => {
      const both = await world({ linking: { jit: true, byVerifiedEmail: false }, provider: { linking: { jit: true } } });
      expect((await both.roundTrip({ claims: { sub: 'new-1', email: 'n@example.test' } })).done.status).to.eq(303);
      expect(both.identities.calls.provision).to.have.length(1);

      const globalOnly = await world({ linking: { jit: true, byVerifiedEmail: false } });
      expect((await globalOnly.roundTrip({ claims: { sub: 'new-1' } })).done.status).to.eq(401);
      expect(globalOnly.identities.calls.provision).to.have.length(0);

      const providerOnly = await world({ provider: { linking: { jit: true } } });
      expect((await providerOnly.roundTrip({ claims: { sub: 'new-1' } })).done.status).to.eq(401);
    });

    it('a throwing hook fails the login and no session is issued', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      w.hook.fail = true;
      const { done } = await w.roundTrip({ claims: { sub: 'kc-1' } });
      expect(done.status).to.eq(401);
      expect(done.cookies.some((c) => c.Name === SESSION_COOKIE)).to.eq(false);
      expect(await w.sessions.storage.storedKeys()).to.deep.eq([]);
    });

    it('a browser navigation fails to the failure page with no reason', async () => {
      const w = await world();
      const { done } = await w.roundTrip({ claims: { sub: 'nobody' } }, { navigation: true });
      expect(done).to.deep.include({ status: 303, location: '/login' });
      expect(done).to.not.have.property('body');
    });

    it('fails alike for an unknown provider, a missing flow cookie, a repeated parameter and a tampered token', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      const answers = [
        await w.login.begin('nope', w.request()),
        await w.login.callback('nope', w.request()),
        await w.login.callback('corp', w.request({ code: 'c', state: 's' })),
        await w.login.callback('corp', w.request({ code: ['a', 'b'], state: 's' }, { [flowCookieName(ENV)]: 'x' })),
        (await w.roundTrip({ claims: { sub: 'kc-1' }, tamper: 'wrong-nonce' })).done,
        (await w.roundTrip({ claims: { sub: 'kc-1' }, tamper: 'alg-none' })).done,
      ];
      for (const a of answers) {
        expect(a).to.deep.include({ status: 401, body: OIDC_FAILURE_BODY });
      }
    });

    it('a replayed callback fails', async () => {
      const w = await world();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'kc-1' });
      const { query, flow, done } = await w.roundTrip({ claims: { sub: 'kc-1' } });
      expect(done.status).to.eq(303);
      const again = await w.login.callback('corp', w.request(query, { [flowCookieName(ENV)]: flow }));
      expect(again.status).to.eq(401);
    });
  });
});
