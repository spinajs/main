import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';
import { KeyRegistry } from '@spinajs/authn/contracts';
import type { IdentityRef, KeyChallenge } from '@spinajs/authn/contracts';
import { FakeClock, generateKeyPair, signCompactJws } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HttpResponse, KitKeyPair } from '@spinajs/authn-testing';

import { KeyRoutesOn } from '../../../src/keys/gate.js';
import { PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { clearLog, logLines } from '../app.js';
import { ROUTES } from '../behaviour/harness.js';
import { KEYS_AUDIENCE, KEY_LOGIN_MFA_POLICY, laneEvents, laneKeysConfig, n8bHarness } from '../behaviour/n8b-harness.js';
import { LaneClient, expectFailureBody, expectRefused, later } from './mfa-enrolment.js';
import { endOfTomorrow } from './tokens.js';
import { mountedRoutes } from './route-table.js';

export const KEY_ROUTES_V3 = ['GET /user/keys', 'POST /user/keys', 'DELETE /user/keys/:kid', 'POST /auth/keys/challenge', 'POST /auth/keys/login'];

/** The keys of one key in a list or registration answer. */
const ENTRY_KEYS = ['alg', 'createdAt', 'expired', 'expiresAt', 'jwk', 'kid', 'lastUsedAt', 'name', 'revoked', 'revokedAt', 'scope', 'thumbprint'];

const body = <T = Record<string, unknown>>(res: HttpResponse): T => res.body as T;

interface WireChallenge {
  id: string;
  nonce: string;
  expiresAt: string;
}

type Entry = Record<string, unknown> & { kid: string; revoked: boolean; expired: boolean };

const asChallenge = (w: WireChallenge): KeyChallenge => ({ id: w.id, nonce: w.nonce, expiresAt: new Date(w.expiresAt) });

/** A proof that is well formed but names no challenge. */
const FAKE_PROOF = { challengeId: 'x', signature: 'y' };

/** The gate on containers of its own; test/v3/route-groups-boot.test.ts boots apps with and without authn-keys. */
export function keyGateSuite(): void {
  it('the gate asks the container it resolves from: a KeyRegistry and an audience in its configuration open it', async () => {
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    const gate = new KeyRoutesOn();
    expect(gate.isEnabled(route, ctrl)).to.eq(true);
    const answer = async (container: IContainer): Promise<'open' | 'not_found'> => {
      (gate as unknown as { Container: unknown }).Container = container;
      try {
        await gate.execute(req, route, ctrl);
        return 'open';
      } catch (e) {
        expect((e as object).constructor.name).to.eq('ResourceNotFound');
        expect((e as { error?: unknown }).error).to.eq('not_found');
        return 'not_found';
      }
    };
    /** A container with a KeyRegistry and a configuration that holds `values` (config path → value) only. */
    const withConfig = (values: Record<string, unknown>): IContainer => {
      const c = new Container().child();
      c.register({ StubKeyRegistry: () => ({}) }.StubKeyRegistry).as(KeyRegistry as never);
      c.register({ StubConfiguration: () => ({ get: (path: string) => values[path] }) }.StubConfiguration).as(Configuration as never);
      return c;
    };
    const CHALLENGE = 'authn.keys.challenge.audience';
    const ASSERTION = 'authn.keys.assertion.audience';
    expect(await answer(new Container()), 'no KeyRegistry').to.eq('not_found');
    expect(await answer(withConfig({})), 'no audience').to.eq('not_found');
    expect(await answer(withConfig({ [CHALLENGE]: '', [ASSERTION]: '' })), 'empty audiences').to.eq('not_found');
    expect(await answer(withConfig({ [ASSERTION]: KEYS_AUDIENCE })), 'assertion.audience').to.eq('open');
    expect(await answer(withConfig({ [CHALLENGE]: KEYS_AUDIENCE })), 'challenge.audience').to.eq('open');
  });
}

let users = 0;

/** The routes over authn-keys' DefaultKeyRegistry and KeyChallengeStrategy, authn-session and N1 (the behaviour harness's app). */
export function keyRoutesSuite(): void {
  let h: Harness;

  const open = async () => {
    h = await n8bHarness({ rule: 'A17', facet: 'A17/http', caseName: 'lane', clock: new FakeClock(), config: {} });
    clearLog();
  };

  beforeEach(open);

  afterEach(async () => {
    await h?.dispose?.();
  });

  const ctx = () => ({ now: new Date(), purpose: 'request' as const });

  const user = async () => {
    users++;
    const login = `key-lane-${users}@example.test`;
    const password = `Key-Lane-Pass-${users}`;
    return { ref: await h.seed!.user({ login, password }), login, password };
  };

  const login = async (u: { login: string; password: string }, c = new LaneClient(h)) => {
    const res = await c.send(ROUTES.login!(u.login, u.password));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return c;
  };

  const challenge = (c: LaneClient, payload: unknown) => c.send({ method: 'POST', path: '/auth/keys/challenge', body: payload });
  const register = (c: LaneClient, payload: unknown, headers: Record<string, string> = {}) => c.send({ method: 'POST', path: '/user/keys', body: payload, headers });
  const list = (c: LaneClient) => c.send({ method: 'GET', path: '/user/keys' });
  const revoke = (c: LaneClient, kid: string) => c.send({ method: 'DELETE', path: `/user/keys/${encodeURIComponent(kid)}` });
  const keyLogin = (c: LaneClient, payload: unknown) => c.send({ method: 'POST', path: '/auth/keys/login', body: payload });

  const wireChallenge = async (c: LaneClient, payload: unknown): Promise<WireChallenge> => {
    const res = await challenge(c, payload);
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return body<WireChallenge>(res);
  };

  const sign = (w: WireChallenge, purpose: 'register' | 'login', kp: KitKeyPair) => h.keyProofs!.sign(asChallenge(w), purpose, kp);

  const proofBody = async (c: LaneClient, kp: KitKeyPair, over: Record<string, unknown> = {}) => {
    const ch = await wireChallenge(c, { purpose: 'register' });
    return { jwk: kp.publicJwk, proof: { challengeId: ch.id, signature: await sign(ch, 'register', kp) }, ...over };
  };

  /** A register challenge on `c`, signed by `kp`, then the registration of `kp` with `over` in the body. */
  const registerKey = async (c: LaneClient, kp: KitKeyPair, over: Record<string, unknown> = {}) => register(c, await proofBody(c, kp, over));

  /** A login challenge for `kid` and the key login with `kp`'s signature over it, on `c`. */
  const loginWithKey = async (kid: string, kp: KitKeyPair, c = new LaneClient(h)) => {
    const ch = await wireChallenge(c, { purpose: 'login', kid });
    const res = await keyLogin(c, { keyId: kid, challengeId: ch.id, signature: await sign(ch, 'login', kp) });
    return { c, ch, res };
  };

  /** A user key of `owner` registered through the registry, not the route. */
  const mintKey = async (owner: IdentityRef, kp = generateKeyPair('EdDSA')) => {
    const userOwner = { type: 'user' as const, id: owner.id };
    const ch = await h.keys!.challenge({ purpose: 'register', owner: userOwner }, ctx());
    if (!ch.ok) throw new Error('no register challenge');
    const r = await h.keys!.register({ owner: userOwner, jwk: kp.publicJwk, proof: { challengeId: ch.challenge.id, signature: await h.keyProofs!.sign(ch.challenge, 'register', kp) } }, ctx());
    if (!r.ok) throw new Error(`key register: ${r.code}`);
    return { kp, kid: r.key.kid };
  };

  /** A client whose every request carries a fresh JWS assertion of `owner`'s key: a key principal. */
  const asKey = (owner: IdentityRef, kp: KitKeyPair, kid: string) => {
    const now = Math.floor(Date.now() / 1000);
    const jws = signCompactJws({ alg: kp.alg, kid, typ: 'spinajs-client+jwt' }, { iss: h.assertion!.issuerOf({ type: 'user', id: owner.id }), aud: KEYS_AUDIENCE, iat: now, exp: now + 120, jti: randomUUID() }, kp);
    return new LaneClient(h, { authorization: `Bearer ${jws}` });
  };

  const probe = async (c: LaneClient) => body<{ principal: { id: string; type: string } | null }>(await c.send({ method: 'GET', path: `/${AUTHN_PROBE_PATH}` })).principal;

  const keyEvents = (type: 'key.register' | 'key.revoke') => laneEvents.filter((e) => e.type === type);
  const stored = async (owner: IdentityRef) => h.keys!.list({ type: 'user', id: owner.id });

  function expectEntry(entry: unknown): asserts entry is Entry {
    expect(Object.keys(entry as object).sort()).to.deep.eq(ENTRY_KEYS);
  }

  function expectBadRequest(res: HttpResponse, error: string): void {
    expect(res.status, JSON.stringify(res.body)).to.eq(400);
    expect(body(res).error).to.eq(error);
    expect(res.headers['cache-control']).to.eq('no-store');
  }

  /** The session cookie's attributes, without its value. */
  const cookieFlags = (res: HttpResponse) => {
    const raw = res.setCookie.find((c) => c.startsWith(`${h.http!.sessionCookie}=`));
    expect(raw, 'a session cookie').to.be.a('string');
    return raw!
      .split(';')
      .slice(1)
      .map((a) => a.trim().toLowerCase())
      .sort();
  };

  describe('registration', () => {
    it('POST /user/keys registers a key over a register challenge of the same session, answers it with no-store and lists it', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      const res = await registerKey(c, kp);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expectEntry(res.body);
      expect(res.body).to.deep.include({ kid: kp.kid, thumbprint: kp.kid, alg: 'EdDSA', jwk: kp.publicJwk, name: null, scope: null, expiresAt: null, revokedAt: null, lastUsedAt: null, revoked: false, expired: false });
      expect(body<Entry[]>(await list(c)).map((e) => e.kid)).to.deep.eq([kp.kid]);
      expect(keyEvents('key.register').map((e) => [e.outcome, e.identity?.id])).to.deep.eq([['success', u.ref.id]]);
    });

    it('takes a P-256 key, a kid, a name and an expiry', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('ES256');
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const res = await registerKey(c, kp, { kid: 'laptop-1', name: 'Laptop', expiresAt });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.include({ kid: 'laptop-1', thumbprint: kp.kid, alg: 'ES256', name: 'Laptop', expiresAt: `${expiresAt.slice(0, 19)}.000Z` });
      expect(body<Entry[]>(await list(c))).to.deep.eq([res.body]);
    });

    it('a signature over the register challenge as a login, or a login challenge, is refused 400 invalid_proof (A17)', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      const reg = await wireChallenge(c, { purpose: 'register' });
      expectBadRequest(await register(c, { jwk: kp.publicJwk, proof: { challengeId: reg.id, signature: await sign(reg, 'login', kp) } }), 'invalid_proof');
      const lc = await wireChallenge(c, { purpose: 'login', kid: kp.kid });
      for (const purpose of ['login', 'register'] as const) expectBadRequest(await register(c, { jwk: kp.publicJwk, proof: { challengeId: lc.id, signature: await sign(lc, purpose, kp) } }), 'invalid_proof');
      expect(await stored(u.ref)).to.deep.eq([]);
    });

    it("another user's register challenge is refused 400 invalid_proof and stays usable by that user", async () => {
      const alice = await user();
      const bob = await user();
      const a = await login(alice);
      const b = await login(bob);
      const bobs = await wireChallenge(b, { purpose: 'register' });
      const kp = generateKeyPair('EdDSA');
      expectBadRequest(await register(a, { jwk: kp.publicJwk, proof: { challengeId: bobs.id, signature: await sign(bobs, 'register', kp) } }), 'invalid_proof');
      expect(await stored(alice.ref)).to.deep.eq([]);
      const bk = generateKeyPair('EdDSA');
      const res = await register(b, { jwk: bk.publicJwk, proof: { challengeId: bobs.id, signature: await sign(bobs, 'register', bk) } });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
    });

    it('a register challenge is single use; a wrong signature burns nothing', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      const other = generateKeyPair('EdDSA');
      const ch = await wireChallenge(c, { purpose: 'register' });
      expectBadRequest(await register(c, { jwk: kp.publicJwk, proof: { challengeId: ch.id, signature: await sign(ch, 'register', other) } }), 'invalid_proof');
      expect((await register(c, { jwk: kp.publicJwk, proof: { challengeId: ch.id, signature: await sign(ch, 'register', kp) } })).status).to.eq(200);
      expectBadRequest(await register(c, { jwk: other.publicJwk, proof: { challengeId: ch.id, signature: await sign(ch, 'register', other) } }), 'invalid_proof');
      expect((await stored(u.ref)).map((k) => k.kid)).to.deep.eq([kp.kid]);
    });

    it('the same key twice or a taken kid answers 409 key_taken', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      expect((await registerKey(c, kp)).status).to.eq(200);
      const again = await registerKey(c, kp);
      expect(again.status, JSON.stringify(again.body)).to.eq(409);
      expect(body(again).error).to.eq('key_taken');
      expect(again.headers['cache-control']).to.eq('no-store');
      const taken = await registerKey(c, generateKeyPair('EdDSA'), { kid: kp.kid });
      expect(taken.status).to.eq(409);
      expect(body(taken)).to.deep.eq(body(again));
      expect(await stored(u.ref)).to.have.length(1);
    });

    it('a malformed or over-long field answers 400 with a stable code before the registry sees it', async () => {
      const u = await user();
      const c = await login(u);
      const jwk = generateKeyPair('EdDSA').publicJwk;
      const valid = (over: Record<string, unknown>) => ({ jwk, proof: FAKE_PROOF, ...over });
      const rows: [string, unknown][] = [
        ['invalid_key', { proof: FAKE_PROOF }],
        ['invalid_key', valid({ jwk: 'jwk' })],
        ['invalid_key', valid({ jwk: [jwk] })],
        ['invalid_key', valid({ jwk: { ...jwk, x5c: ['A'.repeat(600)] } })],
        ['invalid_kid', valid({ kid: '' })],
        ['invalid_kid', valid({ kid: 'k'.repeat(65) })],
        ['invalid_kid', valid({ kid: 'has space' })],
        ['invalid_kid', valid({ kid: 42 })],
        ['invalid_name', valid({ name: '' })],
        ['invalid_name', valid({ name: 'n'.repeat(129) })],
        ['invalid_name', valid({ name: 'bell\u0007' })],
        ['invalid_name', valid({ name: 42 })],
        ['invalid_expiry', valid({ expiresAt: 'tomorrow' })],
        ['invalid_expiry', valid({ expiresAt: endOfTomorrow() })],
        ['invalid_expiry', valid({ expiresAt: Date.now() + 86_400_000 })],
        ['invalid_expiry', valid({ expiresAt: new Date(Date.now() - 60_000).toISOString() })],
        ['invalid_proof', valid({ proof: undefined })],
        ['invalid_proof', valid({ proof: 'proof' })],
        ['invalid_proof', valid({ proof: { signature: 'y' } })],
        ['invalid_proof', valid({ proof: { challengeId: 'x'.repeat(601), signature: 'y' } })],
        ['invalid_proof', valid({ proof: { challengeId: 'x', signature: 'A'.repeat(129) } })],
        ['invalid_proof', valid({ proof: { challengeId: 'x', signature: 42 } })],
        ['invalid_scope', valid({ scope: { permissions: ['doc.read'] } })],
      ];
      for (const [error, payload] of rows) expectBadRequest(await register(c, payload), error);
      expect(await stored(u.ref)).to.deep.eq([]);
      expect(keyEvents('key.register')).to.deep.eq([]);
    });

    it('a key the registry refuses answers 400 invalid_key: another key type, another curve, a private part', async () => {
      const u = await user();
      const c = await login(u);
      const { generateKeyPairSync } = await import('node:crypto');
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
      const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
      const kp = generateKeyPair('EdDSA');
      const withD = kp.privateKey.export({ format: 'jwk' });
      for (const jwk of [rsa, p384, withD]) {
        const ch = await wireChallenge(c, { purpose: 'register' });
        expectBadRequest(await register(c, { jwk, proof: { challengeId: ch.id, signature: await sign(ch, 'register', kp) } }), 'invalid_key');
      }
      expect(await stored(u.ref)).to.deep.eq([]);
    });

    it('a cookie POST from a foreign origin is refused before the route (A22)', async () => {
      const u = await user();
      const c = await login(u);
      const res = await register(c, await proofBody(c, generateKeyPair('EdDSA')), { origin: 'https://evil.example' });
      expect(res.status).to.eq(403);
      expect(await stored(u.ref)).to.deep.eq([]);
    });
  });

  describe('fresh authentication (A13)', () => {
    it('a stale session: without reauthPassword 403 fresh_auth_required, a wrong one the login failure body without Retry-After, the right one registers for that request only', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      await later(301, async () => {
        const payload = await proofBody(c, kp);
        expectRefused(await register(c, payload), 403, 'fresh_auth_required');
        expectFailureBody(await register(c, { ...payload, reauthPassword: 'Not-The-Pass-1' }));
        expect(await stored(u.ref), 'nothing registered, the challenge kept').to.deep.eq([]);
        const res = await register(c, { ...payload, reauthPassword: u.password });
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expectRefused(await register(c, await proofBody(c, generateKeyPair('EdDSA'))), 403, 'fresh_auth_required');
      });
      expect(
        h
          .events!.all()
          .filter((e) => e.type === 'reauth')
          .map((e) => e.outcome),
      ).to.deep.eq(['failure', 'success']);
      expect((await stored(u.ref)).map((k) => k.kid)).to.deep.eq([kp.kid]);
      expect(logLines().join('\n')).to.not.include(u.password);
    });

    it('a reauthPassword over the cap answers the login failure body and verifies nothing', async () => {
      const u = await user();
      const c = await login(u);
      await later(301, async () => expectFailureBody(await register(c, { ...(await proofBody(c, generateKeyPair('EdDSA'))), reauthPassword: 'x'.repeat(PASSWORD_HARD_CAP + 1) })));
      expect(
        h
          .events!.all()
          .filter((e) => e.type === 'reauth')
          .map((e) => e.reason),
      ).to.deep.eq(['password_too_long']);
      expect(await stored(u.ref)).to.deep.eq([]);
    });

    it('listing and revoking need no fresh auth', async () => {
      const u = await user();
      const c = await login(u);
      const { kid } = await mintKey(u.ref);
      await later(301, async () => {
        expect((await list(c)).status).to.eq(200);
        expect((await revoke(c, kid)).status).to.eq(200);
      });
      expect((await stored(u.ref))[0].revokedAt).to.be.instanceOf(Date);
    });
  });

  describe('list and revoke', () => {
    it('GET /user/keys lists the own keys with no-store, revoked and expired ones marked, public material only, never a foreign one', async () => {
      const u = await user();
      const bob = await user();
      const c = await login(u);
      const live = await mintKey(u.ref);
      const gone = await mintKey(u.ref);
      await h.keys!.revoke({ type: 'user', id: u.ref.id }, gone.kid, ctx());
      const soonKp = generateKeyPair('ES256');
      const soon = body<Entry>(await registerKey(c, soonKp, { expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      const foreign = await mintKey(bob.ref);
      const res = await later(120, () => list(c));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      const entries = body<Entry[]>(res);
      expect(entries).to.be.an('array').with.length(3);
      for (const e of entries) expectEntry(e);
      const byKid = new Map(entries.map((e) => [e.kid, e]));
      expect([...byKid.keys()]).to.have.members([live.kid, gone.kid, soon.kid]);
      expect(byKid.get(live.kid)).to.deep.include({ revoked: false, expired: false, revokedAt: null });
      expect(byKid.get(gone.kid)).to.deep.include({ revoked: true, expired: false });
      expect(byKid.get(gone.kid)!.revokedAt).to.be.a('string');
      expect(byKid.get(soon.kid)).to.deep.include({ revoked: false, expired: true });
      for (const e of entries) expect(Object.keys(e.jwk as object).sort()).to.deep.eq(e.alg === 'EdDSA' ? ['crv', 'kty', 'x'] : ['crv', 'kty', 'x', 'y']);
      expect(JSON.stringify(entries)).to.not.include(foreign.kid);
    });

    it('DELETE /user/keys/:kid revokes the own key: 200 with no-store, listed as revoked, it no longer logs in (A17)', async () => {
      const u = await user();
      const c = await login(u);
      const { kp, kid } = await mintKey(u.ref);
      expect((await loginWithKey(kid, kp)).res.status, 'the key logs in').to.eq(200);
      const res = await revoke(c, kid);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body ?? null).to.eq(null);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(body<Entry[]>(await list(c)).map((e) => [e.kid, e.revoked])).to.deep.eq([[kid, true]]);
      expectFailureBody((await loginWithKey(kid, kp)).res);
      expect(keyEvents('key.revoke').map((e) => e.identity?.id)).to.deep.eq([u.ref.id]);
      expect((await revoke(c, kid)).status, 'revoking again changes nothing').to.eq(200);
      expect(keyEvents('key.revoke')).to.have.length(1);
    });

    it('a foreign, an unknown and a malformed kid answer one 404 key_not_found and revoke nothing (IDOR)', async () => {
      const alice = await user();
      const bob = await user();
      const c = await login(alice);
      const bobs = await mintKey(bob.ref);
      const answers = [await revoke(c, bobs.kid), await revoke(c, 'no-such-kid'), await revoke(c, 'k'.repeat(65)), await revoke(c, 'bad kid')];
      for (const res of answers) {
        expectRefused(res, 404, 'key_not_found');
        expect(res.headers['cache-control']).to.eq('no-store');
        expect(res.body).to.deep.eq(answers[0].body);
      }
      expect((await stored(bob.ref))[0].revokedAt).to.eq(undefined);
      expect((await loginWithKey(bobs.kid, bobs.kp)).res.status).to.eq(200);
      expect(keyEvents('key.revoke')).to.deep.eq([]);
    });
  });

  describe('challenges', () => {
    it('a login challenge for an unknown kid looks the same as one for a known kid (A02)', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      const c = new LaneClient(h);
      const known = await challenge(c, { purpose: 'login', kid });
      const unknown = await challenge(c, { purpose: 'login', kid: 'no-such-kid' });
      for (const res of [known, unknown]) {
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expect(Object.keys(body(res)).sort()).to.deep.eq(['expiresAt', 'id', 'nonce']);
        expect(res.headers['cache-control']).to.eq('no-store');
        expect(res.setCookie).to.deep.eq([]);
      }
      expect(Object.keys(unknown.headers).sort()).to.deep.eq(Object.keys(known.headers).sort());
      const shape = (w: WireChallenge) => ({ id: w.id.length, nonce: w.nonce.length, ttl: Math.round((Date.parse(w.expiresAt) - Date.now()) / 1000) });
      expect(shape(body<WireChallenge>(unknown))).to.deep.eq(shape(body<WireChallenge>(known)));
      expect(body<WireChallenge>(known).id).to.not.eq(body<WireChallenge>(unknown).id);
    });

    it('a malformed challenge request answers 400 invalid_purpose or invalid_kid', async () => {
      const c = new LaneClient(h);
      for (const payload of [{}, { purpose: 'other' }, { purpose: 42 }, ['login']]) expectBadRequest(await challenge(c, payload), 'invalid_purpose');
      for (const kid of [undefined, '', 'k'.repeat(65), 'bad kid', 42]) expectBadRequest(await challenge(c, { purpose: 'login', kid }), 'invalid_kid');
    });

    it('throttled login challenges answer 429 with Retry-After, alike for a known and an unknown kid', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      const c = new LaneClient(h);
      let last: HttpResponse | undefined;
      for (let i = 0; i < 40 && last?.status !== 429; i++) last = await challenge(c, { purpose: 'login', kid: i % 2 === 0 ? kid : 'no-such-kid' });
      expect(last!.status).to.eq(429);
      const known = await challenge(c, { purpose: 'login', kid });
      const unknown = await challenge(c, { purpose: 'login', kid: 'no-such-kid' });
      for (const res of [known, unknown]) {
        expect(res.status).to.eq(429);
        expect(body(res).error).to.eq('throttled');
        expect(Number(res.headers['retry-after'])).to.be.greaterThan(0);
      }
      expect(unknown.body).to.deep.eq(known.body);
      expect(unknown.headers['retry-after']).to.eq(known.headers['retry-after']);
    });

    it('a register challenge needs a full session: anonymous and pending callers 401', async () => {
      const u = await user();
      expectRefused(await challenge(new LaneClient(h), { purpose: 'register' }), 401, 'unauthenticated');
      await h.mfa!.enrol(u.ref);
      const pending = await login(u);
      expect(pending.cookie, 'a pending session').to.be.a('string');
      expectRefused(await challenge(pending, { purpose: 'register' }), 401, 'unauthenticated');
    });
  });

  describe('key login', () => {
    it('POST /auth/keys/login issues a session as password login does: the same cookie flags, no-store, the login answer', async () => {
      const u = await user();
      const { kp, kid } = await mintKey(u.ref);
      const byPassword = await new LaneClient(h).send(ROUTES.login!(u.login, u.password));
      const { c, res } = await loginWithKey(kid, kp);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(cookieFlags(res)).to.deep.eq(cookieFlags(byPassword));
      expect(body(res).Identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect(body(res).Authn).to.deep.include({ method: 'key-challenge', strategy: 'keys-challenge', assurance: 'aal1' });
      expect(Object.keys(body(res)).sort()).to.deep.eq(Object.keys(body(byPassword)).sort());
      expect((await probe(c))?.id).to.eq(u.ref.id);
      expect((await c.send(ROUTES.whoami!())).status).to.eq(200);
    });

    it('a key login ends the session the client held and sets a new one', async () => {
      const u = await user();
      const { kp, kid } = await mintKey(u.ref);
      const c = await login(u);
      const held = c.cookie!;
      const { res } = await loginWithKey(kid, kp, c);
      expect(res.status).to.eq(200);
      expect(c.cookie).to.be.a('string').and.to.not.eq(held);
      const old = new LaneClient(h);
      old.cookie = held;
      expect((await old.send(ROUTES.whoami!())).status, 'the held session is gone').to.eq(401);
      expect((await c.send(ROUTES.whoami!())).status).to.eq(200);
    });

    it("every failed key login answers the password login's 401 body, and sets no session", async () => {
      const u = await user();
      const bob = await user();
      const { kp, kid } = await mintKey(u.ref);
      const bobs = await mintKey(bob.ref);
      const wrong = await new LaneClient(h).send(ROUTES.login!(u.login, 'Not-The-Pass-1'));
      expectFailureBody(wrong);
      const c = new LaneClient(h);
      const fresh = () => wireChallenge(c, { purpose: 'login', kid });
      const failures: HttpResponse[] = [];
      const ch1 = await fresh();
      failures.push(await keyLogin(c, { keyId: kid, challengeId: ch1.id, signature: await sign(ch1, 'login', generateKeyPair('EdDSA')) }));
      failures.push(await keyLogin(c, { keyId: kid, challengeId: ch1.id, signature: await sign(ch1, 'register', kp) }));
      const ch2 = await fresh();
      expect((await keyLogin(c, { keyId: kid, challengeId: ch2.id, signature: await sign(ch2, 'login', kp) })).status).to.eq(200);
      failures.push(await keyLogin(new LaneClient(h), { keyId: kid, challengeId: ch2.id, signature: await sign(ch2, 'login', kp) }));
      const unknown = await wireChallenge(c, { purpose: 'login', kid: 'no-such-kid' });
      failures.push(await keyLogin(new LaneClient(h), { keyId: 'no-such-kid', challengeId: unknown.id, signature: await sign(unknown, 'login', kp) }));
      const forBob = await wireChallenge(c, { purpose: 'login', kid: bobs.kid });
      failures.push(await keyLogin(new LaneClient(h), { keyId: kid, challengeId: forBob.id, signature: await sign(forBob, 'login', kp) }));
      for (const payload of [{}, { keyId: kid }, { keyId: 'k'.repeat(65), challengeId: 'x', signature: 'y' }, { keyId: kid, challengeId: 'x'.repeat(601), signature: 'y' }, { keyId: kid, challengeId: 'x', signature: 'A'.repeat(129) }, { keyId: kid, challengeId: 42, signature: 'y' }]) {
        failures.push(await keyLogin(new LaneClient(h), payload));
      }
      for (const res of failures) {
        expectFailureBody(res);
        expect(res.body).to.deep.eq(wrong.body);
        expect(res.setCookie).to.deep.eq([]);
      }
    });

    it('a failed key login ends the session the client held, as a failed password login does', async () => {
      const u = await user();
      const c = await login(u);
      const held = c.cookie!;
      expectFailureBody(await keyLogin(c, { keyId: 'no-such-kid', challengeId: 'x', signature: 'y' }));
      const old = new LaneClient(h);
      old.cookie = held;
      expect((await old.send(ROUTES.whoami!())).status).to.eq(401);
    });

    it('a throttled key login sends Retry-After as a throttled password login does, alike for a known and an unknown kid', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      const throttled = async (keyId: string) => {
        let res: HttpResponse | undefined;
        for (let i = 0; i < 12 && res?.headers['retry-after'] === undefined; i++) res = await keyLogin(new LaneClient(h), { keyId, challengeId: 'x', signature: 'y' });
        return res!;
      };
      const known = await throttled(kid);
      const unknown = await throttled('no-such-kid');
      for (const res of [known, unknown]) expectFailureBody(res, res.headers['retry-after']);
      expect(Number(known.headers['retry-after'])).to.be.greaterThan(0);
      expect(unknown.headers['retry-after']).to.eq(known.headers['retry-after']);
    });

    it('an MFA-enrolled user logs in with a key without the MFA step (N1 D13: a key challenge proves possession)', async () => {
      const u = await user();
      await h.mfa!.enrol(u.ref);
      const { kp, kid } = await mintKey(u.ref);
      const { c, res } = await loginWithKey(kid, kp);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(body(res).MfaRequired).to.eq(undefined);
      expect(body(res).Authn).to.deep.include({ assurance: 'aal1', mfa: [] });
      expect((await probe(c))?.id).to.eq(u.ref.id);
    });

    it('under an MFA policy that asks key logins for TOTP: 200 MfaRequired with a pending session, which the TOTP code completes', async () => {
      await h.dispose?.();
      h = await n8bHarness({ rule: 'A17', facet: 'A17/http', caseName: 'lane', clock: new FakeClock(), config: { authn: { mfa: { policy: { service: KEY_LOGIN_MFA_POLICY } } } } as unknown as ConfigOverrides });
      const u = await user();
      await h.mfa!.enrol(u.ref);
      const { kp, kid } = await mintKey(u.ref);
      const { c, res } = await loginWithKey(kid, kp);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq({ MfaRequired: ['totp'] });
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(c.cookie, 'the pending session cookie').to.be.a('string');
      expect(await probe(c), 'a pending session is no principal').to.eq(null);
      const done = await c.send(ROUTES.mfaVerify!(await h.mfa!.code(u.ref)));
      expect(done.status, JSON.stringify(done.body)).to.eq(200);
      expect(body(done).Authn).to.deep.include({ assurance: 'aal2', mfa: ['totp'] });
      expect((await probe(c))?.id).to.eq(u.ref.id);
    });
  });

  describe('without an audience in authn.keys', () => {
    const all = async (c: LaneClient, kid: string) => [await list(c), await register(c, { jwk: generateKeyPair('EdDSA').publicJwk, proof: FAKE_PROOF }), await revoke(c, kid), await challenge(c, { purpose: 'register' }), await challenge(c, { purpose: 'login', kid }), await keyLogin(c, { keyId: kid, ...FAKE_PROOF })];

    it('the key routes are off: 404 not_found on every route, to a session and to anyone', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      laneKeysConfig({ challenge: { ttlSeconds: 120 } });
      const session = await login(u);
      for (const c of [session, new LaneClient(h)]) for (const res of await all(c, kid)) expectRefused(res, 404, 'not_found');
      expect((await stored(u.ref))[0].revokedAt).to.eq(undefined);
    });

    it('authn.keys.challenge.audience alone turns them on', async () => {
      const u = await user();
      laneKeysConfig({ challenge: { audience: KEYS_AUDIENCE } });
      const res = await list(await login(u));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
    });
  });

  describe('callers that may not manage keys', () => {
    const manage = async (c: LaneClient, kid: string) => [await list(c), await register(c, { jwk: generateKeyPair('EdDSA').publicJwk, proof: FAKE_PROOF }), await revoke(c, kid), await challenge(c, { purpose: 'register' })];

    it('anonymous callers and pending sessions answer 401 on every key management route (A09)', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      for (const res of await manage(new LaneClient(h), kid)) expectRefused(res, 401, 'unauthenticated');
      await h.mfa!.enrol(u.ref);
      const pending = await login(u);
      for (const res of await manage(pending, kid)) expectRefused(res, 401, 'unauthenticated');
      expect((await stored(u.ref))[0].revokedAt).to.eq(undefined);
    });

    it('a token principal is refused 403 session_required and changes nothing', async () => {
      const u = await user();
      const { kid } = await mintKey(u.ref);
      const t = await h.tokens!.create(u.ref, { name: 'lane', kind: 'pat', expiresAt: new Date(Date.now() + 86_400_000) }, ctx());
      if (!t.ok) throw new Error(t.code);
      for (const res of await manage(new LaneClient(h, { authorization: `Bearer ${t.plaintext}` }), kid)) expectRefused(res, 403, 'session_required');
      expect((await stored(u.ref))[0].revokedAt).to.eq(undefined);
    });

    it('a key principal (a JWS assertion) is refused 403 session_required: no key manages keys', async () => {
      const u = await user();
      const { kp, kid } = await mintKey(u.ref);
      expect((await probe(asKey(u.ref, kp, kid)))?.id, 'the assertion authenticates').to.eq(u.ref.id);
      const answers = [await list(asKey(u.ref, kp, kid)), await register(asKey(u.ref, kp, kid), { jwk: generateKeyPair('EdDSA').publicJwk, proof: FAKE_PROOF }), await revoke(asKey(u.ref, kp, kid), kid), await challenge(asKey(u.ref, kp, kid), { purpose: 'register' })];
      for (const res of answers) expectRefused(res, 403, 'session_required');
      expect((await stored(u.ref))[0].revokedAt).to.eq(undefined);
    });

    it('an impersonated session is refused 403 impersonating: a key added there would outlive the impersonation', async () => {
      await h.guard!.allowAll();
      const admin = await user();
      const target = await user();
      const { kid } = await mintKey(target.ref);
      await h.mfa!.enrol(admin.ref);
      const c = await login(admin);
      await later(30, async () => expect((await c.send(ROUTES.mfaVerify!(await h.mfa!.code(admin.ref)))).status).to.eq(200));
      const started = await c.send(ROUTES.impersonateStart!(target.ref, admin.password));
      expect(started.status, JSON.stringify(started.body)).to.eq(200);
      for (const res of await manage(c, kid)) expectRefused(res, 403, 'impersonating');
      expect((await stored(target.ref))[0].revokedAt).to.eq(undefined);
    });
  });

  describe('secrets and wiring', () => {
    it('no challenge, signature or reauthPassword reaches a log line or an audit event', async () => {
      const u = await user();
      const c = await login(u);
      const kp = generateKeyPair('EdDSA');
      // A stale session, so the password is verified.
      const { reg, regSignature } = await later(301, async () => {
        const reg = await wireChallenge(c, { purpose: 'register' });
        const regSignature = await sign(reg, 'register', kp);
        const registered = await register(c, { jwk: kp.publicJwk, proof: { challengeId: reg.id, signature: regSignature }, reauthPassword: u.password });
        expect(registered.status, JSON.stringify(registered.body)).to.eq(200);
        return { reg, regSignature };
      });
      expect(h.events!.all().filter((e) => e.type === 'reauth' && e.outcome === 'success')).to.have.length(1);
      const { ch, res } = await loginWithKey(kp.kid, kp);
      expect(res.status).to.eq(200);
      // Ed25519 signatures are deterministic: this is the signature the login sent.
      const loginSignature = await sign(ch, 'login', kp);
      const seen = { logs: logLines().join('\n'), laneEvents: JSON.stringify(laneEvents), events: JSON.stringify(h.events!.all()) };
      const secrets = { registerNonce: reg.nonce, registerId: reg.id, registerSignature: regSignature, loginNonce: ch.nonce, loginId: ch.id, loginSignature, password: u.password };
      for (const [where, text] of Object.entries(seen)) for (const [name, value] of Object.entries(secrets)) expect(text, `${name} in ${where}`).to.not.include(value);
    });

    it('the five routes are mounted once', async () => {
      const routes = await mountedRoutes();
      for (const route of KEY_ROUTES_V3)
        expect(
          routes.filter((r) => r === route),
          route,
        ).to.have.length(1);
    });
  });
}
