import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { IdentityRef, JwsClaims, JwsKey, JwsVerifyOptions, KeyAlgorithm, KeyChallenge, KeyOwner, KeyRecord, KeyRegisterResult, KeyRegistry } from '@spinajs/authn/contracts';
import type { Harness, KitKeyPair } from '../harness/ports.js';
import { b64url, b64urlDecode, backoffDelayMs, generateKeyPair, retryAfterSeconds, signCompactJws, thumbprint } from '../helpers/index.js';
import { ALICE, auth, expectFail, expectSuccess, probe, send, seedUser, sessionCookieOf } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

const SECOND = 1000;
const SERVICE_OWNER: KeyOwner = { type: 'service', id: 'kit-svc' };
const ADMIN = { type: 'user', id: 'kit-admin' } as const;

export type UserOwner = KeyOwner & { readonly type: 'user' };

export const userOwner = (a: IdentityRef): UserOwner => ({ type: 'user', id: a.id });

export const nowSeconds = (k: CaseKit): number => Math.floor(k.clock.now().getTime() / SECOND);

const registered = (r: KeyRegisterResult): KeyRecord => {
  assert.ok(r.ok, `registration ${JSON.stringify(r)}`);
  return r.key;
};

/** reg(kp, owner = service): the admin path, no proof. */
const reg = (keys: KeyRegistry, k: CaseKit, kp: KitKeyPair, over: { owner?: KeyOwner & { type: 'service' | 'agent' }; kid?: string } = {}): Promise<KeyRegisterResult> => keys.register({ owner: over.owner ?? (SERVICE_OWNER as KeyOwner & { type: 'service' }), actor: ADMIN, jwk: kp.publicJwk, ...(over.kid ? { kid: over.kid } : {}) }, k.ctx());

type WithKeyProofs = Harness & Required<Pick<Harness, 'keys' | 'keyProofs'>>;

/** The user path: a register challenge, the key's signature over it, then the registration. */
export async function registerUserKey(h: WithKeyProofs, k: CaseKit, kp: KitKeyPair, owner: UserOwner, over: { expiresAt?: Date; signature?: string; signWith?: KitKeyPair; purpose?: 'register' | 'login'; challenge?: KeyChallenge } = {}): Promise<KeyRegisterResult> {
  let challenge = over.challenge;
  if (!challenge) {
    const ch = await h.keys.challenge({ purpose: 'register', owner }, k.ctx());
    assert.ok(ch.ok, 'a register challenge is issued');
    challenge = ch.challenge;
  }
  const signature = over.signature ?? (await h.keyProofs.sign(challenge, over.purpose ?? 'register', over.signWith ?? kp));
  return h.keys.register({ owner, jwk: kp.publicJwk, ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}), proof: { challengeId: challenge.id, signature } }, k.ctx());
}

const jwkOf = (privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] | ReturnType<typeof generateKeyPairSync>['publicKey']): Record<string, unknown> => privateKey.export({ format: 'jwk' }) as Record<string, unknown>;

const publicJwkOf = (pair: ReturnType<typeof generateKeyPairSync>): Record<string, unknown> => jwkOf(pair.publicKey);

const KEY_ROWS: readonly { readonly label: string; readonly jwk: () => unknown; readonly alg?: 'EdDSA' | 'ES256' }[] = [
  { label: 'Ed25519', jwk: () => generateKeyPair('EdDSA').publicJwk, alg: 'EdDSA' },
  { label: 'P-256', jwk: () => generateKeyPair('ES256').publicJwk, alg: 'ES256' },
  { label: 'RSA', jwk: () => publicJwkOf(generateKeyPairSync('rsa', { modulusLength: 2048 })) },
  { label: 'P-384', jwk: () => publicJwkOf(generateKeyPairSync('ec', { namedCurve: 'P-384' })) },
  {
    label: 'Ed25519 with d',
    jwk: () => {
      const pair = generateKeyPairSync('ed25519');
      return jwkOf(pair.privateKey);
    },
  },
  { label: 'secp256k1', jwk: () => publicJwkOf(generateKeyPairSync('ec', { namedCurve: 'secp256k1' })) },
];

const PROOF_ROWS: readonly { readonly label: string; readonly ok: boolean; readonly over?: (kp: KitKeyPair, other: KitKeyPair) => Parameters<typeof registerUserKey>[4] }[] = [
  { label: 'valid', ok: true },
  { label: 'signed by another key', ok: false, over: (_kp, other) => ({ signWith: other }) },
  { label: 'login signature', ok: false, over: () => ({ purpose: 'login' }) },
  { label: 'challenge used twice', ok: false },
  { label: 'garbage signature', ok: false, over: () => ({ signature: 'AAAA' }) },
];

interface JwsFixture {
  readonly kp: KitKeyPair;
  readonly key: JwsKey;
  readonly t: Date;
  readonly tS: number;
}

const BASE_TYP = 'kit+jwt';

const fixture = (k: CaseKit, alg: KeyAlgorithm = 'EdDSA'): JwsFixture => {
  const kp = generateKeyPair(alg);
  return { kp, key: { alg, jwk: kp.publicJwk, kid: kp.kid } as JwsKey, t: k.clock.now(), tS: nowSeconds(k) };
};

const baseClaims = (f: JwsFixture, over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: 'kit-iss', aud: 'kit-aud', iat: f.tS, exp: f.tS + 120, ...over });

const baseHeader = (f: JwsFixture, over: Record<string, unknown> = {}): Record<string, unknown> => ({ alg: f.key.alg, kid: f.key.kid, typ: BASE_TYP, ...over });

const baseToken = (f: JwsFixture, claims: Record<string, unknown> = baseClaims(f), header: Record<string, unknown> = baseHeader(f)): string => signCompactJws(header, claims, f.kp);

const baseOptions = (f: Pick<JwsFixture, 'key' | 't'>, over: Partial<JwsVerifyOptions<JwsClaims>> = {}): JwsVerifyOptions<JwsClaims> => ({
  typ: BASE_TYP,
  algorithms: ['EdDSA', 'ES256'],
  keys: async (kid) => (kid === f.key.kid ? f.key : null),
  claims: (p) => p as unknown as JwsClaims,
  issuer: 'kit-iss',
  audience: 'kit-aud',
  now: f.t,
  skewSeconds: 30,
  maxLifetimeSeconds: 300,
  ...over,
});

const flipBit = (token: string): string => {
  const [h, p, s] = token.split('.');
  const sig = b64urlDecode(s);
  sig[0] ^= 1;
  return `${h}.${p}.${b64url(sig)}`;
};

/** A valid token whose signature part holds '-' or '_' (re-signed with a varying claim), rewritten with the standard base64 characters. */
const signatureWithStandardBase64 = (f: JwsFixture): string => {
  for (let i = 0; i < 1000; i += 1) {
    const [h, p, sig] = baseToken(f, baseClaims(f, { jti: String(i) })).split('.');
    if (/[-_]/.test(sig)) {
      return `${h}.${p}.${sig.replace(/-/g, '+').replace(/_/g, '/')}`;
    }
  }
  throw new Error('no signature with - or _ found');
};

const derEs256Token = (f: JwsFixture): string => {
  const input = `${b64url(JSON.stringify(baseHeader(f)))}.${b64url(JSON.stringify(baseClaims(f)))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), { key: f.kp.privateKey, dsaEncoding: 'der' }))}`;
};

const withPart = (token: string, index: number, value: string): string =>
  token
    .split('.')
    .map((part, i) => (i === index ? value : part))
    .join('.');

const secondsAt = (s: number): Date => new Date(s * SECOND);

interface JwsRow {
  readonly label: string;
  readonly code: string;
  readonly alg?: KeyAlgorithm;
  readonly token: (f: JwsFixture) => string;
  readonly options?: (f: JwsFixture) => Partial<JwsVerifyOptions<JwsClaims>>;
}

const JWS_ROWS: readonly JwsRow[] = [
  { label: 'valid', code: 'ok', token: (f) => baseToken(f) },
  { label: 'valid ES256', code: 'ok', alg: 'ES256', token: (f) => baseToken(f) },
  { label: 'ES256 DER signature', code: 'malformed', alg: 'ES256', token: derEs256Token },
  { label: 'two parts', code: 'malformed', token: () => 'a.b' },
  { label: 'bad base64url', code: 'malformed', token: signatureWithStandardBase64 },
  { label: 'trailing =', code: 'malformed', token: (f) => `${baseToken(f)}=` },
  { label: '63-byte signature', code: 'malformed', token: (f) => withPart(baseToken(f), 2, b64url(Buffer.alloc(63, 1))) },
  { label: 'extra header member', code: 'bad_header', token: (f) => baseToken(f, baseClaims(f), baseHeader(f, { cty: 'x' })) },
  { label: 'missing typ', code: 'bad_header', token: (f) => baseToken(f, baseClaims(f), { alg: f.key.alg, kid: f.key.kid }) },
  { label: 'wrong typ', code: 'bad_header', token: (f) => baseToken(f, baseClaims(f), baseHeader(f, { typ: 'JWT' })) },
  { label: 'alg not allowed', code: 'bad_header', token: (f) => baseToken(f), options: () => ({ algorithms: ['ES256'] }) },
  { label: 'unknown kid', code: 'unknown_key', token: (f) => baseToken(f, baseClaims(f), baseHeader(f, { kid: 'kit-nope' })) },
  { label: 'key alg differs from header', code: 'unknown_key', token: (f) => baseToken(f, baseClaims(f), baseHeader(f, { alg: 'ES256' })) },
  { label: 'bad signature', code: 'bad_signature', token: (f) => flipBit(baseToken(f)) },
  { label: 'bad signature beats expired', code: 'bad_signature', token: (f) => flipBit(baseToken(f, baseClaims(f, { iat: f.tS - 220, exp: f.tS - 100 }))) },
  { label: 'claims rejected', code: 'invalid_claims', token: (f) => baseToken(f), options: () => ({ claims: () => null }) },
  { label: 'exp ≤ iat', code: 'invalid_claims', token: (f) => baseToken(f, baseClaims(f, { exp: f.tS })) },
  { label: 'lifetime over max', code: 'invalid_claims', token: (f) => baseToken(f, baseClaims(f, { exp: f.tS + 301 })) },
  { label: 'lifetime over max beats wrong issuer', code: 'invalid_claims', token: (f) => baseToken(f, baseClaims(f, { iss: 'other', exp: f.tS + 301 })) },
  { label: 'wrong issuer', code: 'wrong_issuer', token: (f) => baseToken(f, baseClaims(f, { iss: 'other' })) },
  { label: 'wrong issuer beats expired', code: 'wrong_issuer', token: (f) => baseToken(f, baseClaims(f, { iss: 'other', iat: f.tS - 220, exp: f.tS - 100 })) },
  { label: 'wrong issuer beats wrong audience', code: 'wrong_issuer', token: (f) => baseToken(f, baseClaims(f, { iss: 'other', aud: 'other' })) },
  { label: 'wrong audience', code: 'wrong_audience', token: (f) => baseToken(f, baseClaims(f, { aud: 'other' })) },
  { label: 'wrong audience beats expired', code: 'wrong_audience', token: (f) => baseToken(f, baseClaims(f, { aud: 'other', iat: f.tS - 220, exp: f.tS - 100 })) },
  { label: 'expired at the boundary', code: 'expired', token: (f) => baseToken(f), options: (f) => ({ now: secondsAt(f.tS + 120 + 30) }) },
  { label: 'not expired 1 s before', code: 'ok', token: (f) => baseToken(f), options: (f) => ({ now: secondsAt(f.tS + 120 + 29) }) },
  { label: 'not yet valid', code: 'not_yet_valid', token: (f) => baseToken(f, baseClaims(f, { iat: f.tS + 31, exp: f.tS + 91 })) },
  { label: 'iat at the skew edge', code: 'ok', token: (f) => baseToken(f, baseClaims(f, { iat: f.tS + 30, exp: f.tS + 90 })) },
];

type AssertionHarness = Harness & Required<Pick<Harness, 'service' | 'keys' | 'keyProofs' | 'assertion' | 'seed'>>;

const ASSERTION_TYP = 'spinajs-client+jwt';

function assertionFor(h: AssertionHarness, k: CaseKit, kp: KitKeyPair, kid: string, owner: UserOwner, lifetime: number): string {
  const nowS = nowSeconds(k);
  return signCompactJws({ alg: kp.alg, kid, typ: ASSERTION_TYP }, { iss: h.assertion.issuerOf(owner), aud: h.assertion.audience, iat: nowS, exp: nowS + lifetime, jti: randomUUID() }, kp);
}

/** A seeded user with a key (Ed25519 by default) registered through the proof path. */
export async function userKey(h: WithKeyProofs & Required<Pick<Harness, 'seed'>>, k: CaseKit, over: { expiresAt?: Date; alg?: KeyAlgorithm } = {}) {
  const a = await seedUser(h, ALICE);
  const owner = userOwner(a);
  const kp = generateKeyPair(over.alg ?? 'EdDSA');
  const key = registered(await registerUserKey(h, k, kp, owner, over.expiresAt ? { expiresAt: over.expiresAt } : {}));
  return { a, owner, kp, kid: key.kid };
}

const ASSERTION_NEEDS = ['service', 'keys', 'keyProofs', 'assertion', 'seed'] as const;

const LIFETIME_ROWS = [
  { label: '300 s', lifetime: 300, ok: true },
  { label: '301 s', lifetime: 301, ok: false },
] as const;

/** First object with a string `id` and `nonce`, found depth first. */
function findChallenge(body: unknown): { id: string; nonce: string; expiresAt: string } | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const o = body as Record<string, unknown>;
  if (typeof o.id === 'string' && typeof o.nonce === 'string') {
    return o as { id: string; nonce: string; expiresAt: string };
  }
  for (const v of Object.values(o)) {
    const found = findChallenge(v);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** The route may send an ISO string, epoch milliseconds or epoch seconds. */
const challengeExpiry = (v: unknown): Date => (typeof v === 'number' ? new Date(v < 1e11 ? v * SECOND : v) : new Date(v as string));

export const A17: AuthnRule = defineRule('A17', 'keys are Ed25519 or P-256 and JWS follows the C8 rules', [
  table(KEY_ROWS, (row) =>
    defineCase({
      name: `A17 only Ed25519 and P-256 public keys register: ${row.label}`,
      facet: 'A17/keys',
      needs: ['keys'],
      async run(h, k) {
        const r = await h.keys.register({ owner: SERVICE_OWNER as KeyOwner & { type: 'service' }, actor: ADMIN, jwk: row.jwk() as never }, k.ctx());
        if (row.alg) {
          assert.ok(r.ok, `registration ${JSON.stringify(r)}`);
          assert.strictEqual(r.key.alg, row.alg);
        } else {
          assert.deepStrictEqual({ ...r }, { ok: false, code: 'invalid_key' });
        }
      },
    }),
  ),
  defineCase({
    name: 'A17 the default kid is the RFC 7638 thumbprint',
    facet: 'A17/keys',
    needs: ['keys'],
    async run(h, k) {
      const kp = generateKeyPair('EdDSA');
      const key = registered(await reg(h.keys, k, kp));
      assert.strictEqual(key.thumbprint, thumbprint(kp.publicJwk));
      assert.strictEqual(key.kid, key.thumbprint);
    },
  }),
  defineCase({
    name: 'A17 kid and thumbprint are unique',
    facet: 'A17/keys',
    needs: ['keys'],
    async run(h, k) {
      const kp = generateKeyPair('EdDSA');
      const kp2 = generateKeyPair('ES256');
      const first = registered(await reg(h.keys, k, kp));
      assert.deepStrictEqual({ ...(await reg(h.keys, k, kp)) }, { ok: false, code: 'duplicate' }, 'the same key twice');
      assert.deepStrictEqual({ ...(await reg(h.keys, k, kp2, { kid: first.kid })) }, { ok: false, code: 'duplicate' }, 'the same kid for another key');
    },
  }),
  table(PROOF_ROWS, (row) =>
    defineCase({
      name: `A17 a user's key needs a proof over a register challenge: ${row.label}`,
      facet: 'A17/keys',
      needs: ['keys', 'keyProofs', 'seed'],
      async run(h, k) {
        const owner = userOwner(await seedUser(h, ALICE));
        const kp = generateKeyPair('EdDSA');
        const other = generateKeyPair('EdDSA');
        const first = await registerUserKey(h, k, kp, owner, row.over?.(kp, other));
        if (row.ok) {
          assert.ok(first.ok, `registration ${JSON.stringify(first)}`);
          return;
        }
        if (row.label === 'challenge used twice') {
          assert.ok(first.ok, 'the first use of the challenge');
          const ch = await h.keys.challenge({ purpose: 'register', owner }, k.ctx());
          assert.ok(ch.ok);
          assert.ok((await registerUserKey(h, k, other, owner, { challenge: ch.challenge })).ok, 'the first use of a second challenge');
          const again = await registerUserKey(h, k, generateKeyPair('EdDSA'), owner, { challenge: ch.challenge });
          assert.deepStrictEqual({ ...again }, { ok: false, code: 'invalid_proof' });
          return;
        }
        assert.deepStrictEqual({ ...first }, { ok: false, code: 'invalid_proof' });
      },
    }),
  ),
  defineCase({
    name: 'A17 revoke is owner-bound and recorded',
    facet: 'A17/keys',
    needs: ['keys'],
    async run(h, k) {
      const kp = generateKeyPair('EdDSA');
      const { kid } = registered(await reg(h.keys, k, kp));
      assert.strictEqual(await h.keys.revoke({ type: 'service', id: 'other' }, kid, k.ctx()), false, 'another owner cannot revoke it');
      assert.strictEqual(await h.keys.revoke(SERVICE_OWNER, kid, k.ctx()), true);
      assert.ok((await h.keys.byId(kid))?.revokedAt, 'revokedAt is set');
      assert.ok(
        (await h.keys.list(SERVICE_OWNER)).some((x) => x.kid === kid),
        'a revoked key is still listed',
      );
    },
  }),
  table(JWS_ROWS, (row) =>
    defineCase({
      name: `A17 JwsVerifier reports ${row.code}: ${row.label}`,
      facet: 'A17/jws',
      needs: ['jws'],
      async run(h, k) {
        const f = fixture(k, row.alg);
        const res = await h.jws.verifier.verify(row.token(f), baseOptions(f, row.options?.(f)));
        if (row.code === 'ok') {
          assert.strictEqual(res.ok, true, `verification ${JSON.stringify(res)}`);
        } else {
          assert.deepStrictEqual({ ...res }, { ok: false, code: row.code });
        }
      },
    }),
  ),
  defineCase({
    name: 'A17 the signer writes { alg, kid, typ } in order and is deterministic',
    facet: 'A17/jws',
    needs: ['jws'],
    async run(h, k) {
      const { signer, verifier } = h.jws;
      assert.ok(signer, 'the harness provides a signer for this facet');
      const [k0] = await signer.publicKeys();
      const tS = nowSeconds(k);
      const claims = { iss: 'kit-iss', aud: 'kit-aud', iat: tS, exp: tS + 120 };
      const t1 = await signer.sign(claims, { typ: BASE_TYP });
      const t2 = await signer.sign(claims, { typ: BASE_TYP });
      const [header, payload] = t1.split('.');
      assert.deepStrictEqual(Object.keys(JSON.parse(b64urlDecode(header).toString('utf8'))), ['alg', 'kid', 'typ']);
      assert.ok(k0.alg !== 'EdDSA' || t1 === t2, 'EdDSA signatures are deterministic');
      assert.deepStrictEqual(Object.keys(JSON.parse(b64urlDecode(payload).toString('utf8'))), Object.keys(claims));
      const res = await verifier.verify(t1, baseOptions({ key: k0, t: k.clock.now() }));
      assert.strictEqual(res.ok, true, `verification ${JSON.stringify(res)}`);
    },
  }),
  table(LIFETIME_ROWS, (row) =>
    defineCase({
      name: `A17 an assertion lives at most 300 s: ${row.label}`,
      facet: 'A17/core',
      needs: ASSERTION_NEEDS,
      async run(h, k) {
        const { owner, kp, kid } = await userKey(h, k);
        const r = await auth(h, k, { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, row.lifetime) }, { purpose: 'request' });
        assert.strictEqual(r.status, row.ok ? 'success' : 'failure', `result ${JSON.stringify(r)}`);
      },
    }),
  ),
  defineCase({
    name: 'A17 a jti is accepted once within its lifetime',
    facet: 'A17/core',
    needs: ASSERTION_NEEDS,
    async run(h, k) {
      const { owner, kp, kid } = await userKey(h, k);
      const credentials = { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, 120) };
      expectSuccess(await auth(h, k, credentials, { purpose: 'request' }));
      expectFail(await auth(h, k, credentials, { purpose: 'request' }), 'the same assertion again');
    },
  }),
  defineCase({
    name: 'A17 a revoked key fails on the next request',
    facet: 'A17/core',
    needs: ASSERTION_NEEDS,
    async run(h, k) {
      const { owner, kp, kid } = await userKey(h, k);
      expectSuccess(await auth(h, k, { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, 120) }, { purpose: 'request' }));
      assert.strictEqual(await h.keys.revoke(owner, kid, k.ctx()), true);
      expectFail(await auth(h, k, { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, 120) }, { purpose: 'request' }));
    },
  }),
  defineCase({
    name: 'A17 an expired key fails',
    facet: 'A17/core',
    needs: [...ASSERTION_NEEDS, 'fakeDate'],
    async run(h, k) {
      const { owner, kp, kid } = await userKey(h, k, { expiresAt: new Date(k.clock.now().getTime() + 60 * SECOND) });
      k.clock.tick(59 * SECOND);
      expectSuccess(await auth(h, k, { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, 120) }, { purpose: 'request' }), 'the key before its expiry');
      k.clock.tick(2 * SECOND);
      expectFail(await auth(h, k, { kind: 'jws-assertion', jws: assertionFor(h, k, kp, kid, owner, 120) }, { purpose: 'request' }));
    },
  }),
  defineCase({
    name: 'A17 a login challenge is single use',
    facet: 'A17/core',
    needs: ['service', 'keys', 'keyProofs', 'seed'],
    async run(h, k) {
      const { kp, kid } = await userKey(h, k);
      const ch = await h.keys.challenge({ purpose: 'login', kid }, k.ctx());
      assert.ok(ch.ok, 'a login challenge is issued');
      const credentials = { kind: 'key-challenge', keyId: kid, challengeId: ch.challenge.id, signature: await h.keyProofs.sign(ch.challenge, 'login', kp) };
      expectSuccess(await auth(h, k, credentials));
      expectFail(await auth(h, k, credentials), 'the same challenge again');
    },
  }),
  defineCase({
    name: 'A17 a login challenge for an unknown kid looks the same and never verifies',
    facet: 'A17/core',
    needs: ['service', 'keys', 'keyProofs'],
    async run(h, k) {
      const kp = generateKeyPair('EdDSA');
      const ch = await h.keys.challenge({ purpose: 'login', kid: 'kit-unknown' }, k.ctx());
      assert.ok(ch.ok, 'a challenge is issued for an unknown kid too');
      assert.deepStrictEqual(Object.keys(ch.challenge).sort(), ['expiresAt', 'id', 'nonce']);
      expectFail(await auth(h, k, { kind: 'key-challenge', keyId: 'kit-unknown', challengeId: ch.challenge.id, signature: await h.keyProofs.sign(ch.challenge, 'login', kp) }));
    },
  }),
  defineCase({
    name: 'A17 login challenges count against the login ip key',
    facet: 'A17/core',
    needs: ['keys', 'throttle'],
    async run(h, k) {
      const ip = h.throttle.params.login.ip;
      assert.ok(ip !== undefined, 'the login flow has an ip key');
      const free = ip.free;
      for (let i = 0; i < free; i += 1) {
        assert.ok((await h.keys.challenge({ purpose: 'login', kid: 'kit-x' }, k.ctx())).ok, `challenge ${i + 1} of ${free}`);
      }
      assert.deepStrictEqual({ ...(await h.keys.challenge({ purpose: 'login', kid: 'kit-x' }, k.ctx())) }, { ok: false, retryAfterSeconds: retryAfterSeconds(backoffDelayMs(ip, free)) });
    },
  }),
  defineCase({
    name: 'A17 a key challenge login issues a session over HTTP',
    facet: 'A17/http',
    needs: ['http', 'http.routes.keyChallenge', 'http.routes.keyLogin', 'keys', 'keyProofs', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const kp = generateKeyPair('EdDSA');
      const { kid } = registered(await registerUserKey(h, k, kp, userOwner(a)));
      const jar = k.jar();
      const challenge = await send(h, h.http.routes.keyChallenge!({ purpose: 'login', kid }), jar);
      assert.ok(challenge.status >= 200 && challenge.status < 300, `challenge status ${challenge.status}`);
      const ch = findChallenge(challenge.body);
      assert.ok(ch, `a challenge in ${JSON.stringify(challenge.body)}`);
      const signature = await h.keyProofs.sign({ id: ch.id, nonce: ch.nonce, expiresAt: challengeExpiry(ch.expiresAt) }, 'login', kp);
      const login = await send(h, h.http.routes.keyLogin!({ keyId: kid, challengeId: ch.id, signature }), jar);
      assert.ok(login.status >= 200 && login.status < 300, `login status ${login.status}`);
      assert.ok(sessionCookieOf(h, login), 'the login sets the session cookie');
      const res = await send(h, probe(h, 'GET'), jar);
      assert.strictEqual((res.body as { principal?: { id?: string } | null }).principal?.id, a.id);
    },
  }),
]);
