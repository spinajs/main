import * as chai from 'chai';
import 'mocha';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

import { KeyRegistry } from '../../src/contracts/keys.js';
import type { Ed25519PublicJwk, KeyAlgorithm, KeyChallenge, KeyChallengeRequest, KeyChallengeResult, KeyMaterial, KeyOwner, KeyProof, KeyRecord, KeyRegisterResult, KeyRegistration, NewKey, P256PublicJwk, PublicJwk } from '../../src/contracts/keys.js';
import type { AuthnContext, IdentityRef } from '../../src/contracts/credentials.js';
import type { Ceiling, PrincipalRef } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, memberDocs, same, shapeOf, unionLiterals } from './source-shape.js';

const expect = chai.expect;

const ctx: AuthnContext = { now: new Date(0), ip: '10.0.0.1', purpose: 'request' };
const alice = { type: 'user', id: 'alice' } as const;
const runner = { type: 'service', id: 'runner' } as const;
const admin: PrincipalRef = { type: 'user', id: 'root' };
const KID = /^[A-Za-z0-9._-]{1,64}$/;

function newEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  const jwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: x! };
  return { jwk, sign: (message: string) => sign(null, Buffer.from(message), privateKey).toString('base64url') };
}

const thumbprint = (jwk: PublicJwk) =>
  createHash('sha256')
    .update(jwk.kty === 'OKP' ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }) : JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');

// Enough of a registry to show the contract can be implemented as §22.10 describes it.
class MemoryKeys extends KeyRegistry {
  private readonly keys = new Map<string, KeyRecord>();
  private readonly challenges = new Map<string, { purpose: 'register' | 'login'; bound: string; nonce: string }>();
  private readonly loginChallengesByIp = new Map<string, number>();
  async register(reg: KeyRegistration, at: AuthnContext): Promise<KeyRegisterResult> {
    const jwk: unknown = reg.jwk;
    const j = jwk as Record<string, unknown>;
    if ('d' in j || j.kty !== 'OKP' || j.crv !== 'Ed25519' || (reg.kid !== undefined && !KID.test(reg.kid))) return { ok: false, code: 'invalid_key' };
    if (reg.owner.type === 'user') {
      const proof = 'proof' in reg ? reg.proof : undefined;
      const c = proof && this.challenges.get(proof.challengeId);
      this.challenges.delete(proof?.challengeId ?? '');
      const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: reg.jwk.x }, format: 'jwk' });
      if (!c || c.purpose !== 'register' || c.bound !== reg.owner.id || !verify(null, Buffer.from(`register:${c.nonce}`), pub, Buffer.from(proof!.signature, 'base64url'))) return { ok: false, code: 'invalid_proof' };
    }
    const tp = thumbprint(reg.jwk);
    const kid = reg.kid ?? tp;
    if (this.keys.has(kid) || [...this.keys.values()].some((k) => k.thumbprint === tp)) return { ok: false, code: 'duplicate' };
    const key: KeyRecord = { kid, alg: 'EdDSA', jwk: reg.jwk as Ed25519PublicJwk, owner: reg.owner, thumbprint: tp, name: reg.name, scope: reg.scope, createdAt: at.now, createdBy: 'actor' in reg ? reg.actor : reg.owner };
    this.keys.set(kid, key);
    return { ok: true, key };
  }
  async list(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    return [...this.keys.values()].filter((k) => k.owner.type === owner.type && k.owner.id === owner.id);
  }
  async revoke(owner: IdentityRef, kid: string, at: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const k = this.keys.get(kid);
    if (!k || k.owner.type !== owner.type || k.owner.id !== owner.id || k.revokedAt) return false;
    this.keys.set(kid, { ...k, revokedAt: at.now });
    return true;
  }
  async byId(kid: string): Promise<KeyRecord | null> {
    return this.keys.get(kid) ?? null;
  }
  async challenge(req: KeyChallengeRequest, at: AuthnContext): Promise<KeyChallengeResult> {
    if (req.purpose === 'login') {
      const n = (this.loginChallengesByIp.get(at.ip ?? '') ?? 0) + 1;
      if (n > 3) return { ok: false, retryAfterSeconds: 10 };
      this.loginChallengesByIp.set(at.ip ?? '', n);
    }
    const id = randomBytes(16).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    this.challenges.set(id, { purpose: req.purpose, bound: req.purpose === 'register' ? req.owner.id : req.kid, nonce });
    return { ok: true, challenge: { id, nonce, expiresAt: new Date(at.now.getTime() + 60_000) } };
  }
  get stored(): number {
    return this.challenges.size;
  }
}

const issued = async (r: KeyRegistry, req: KeyChallengeRequest, at = ctx): Promise<KeyChallenge> => {
  const res = await r.challenge(req, at);
  if (!res.ok) throw new Error('throttled');
  return res.challenge;
};

describe('key registry contract', () => {
  describe('runtime', () => {
    it('exports KeyRegistry from the contracts index as a plain abstract class', () => {
      expect(index.KeyRegistry).to.eq(KeyRegistry);
      expect(KeyRegistry).to.be.a('function');
      expect(Object.getPrototypeOf(KeyRegistry)).to.eq(Function.prototype);
    });

    it('a user registers a key only with a signature over a register challenge', async () => {
      const r = new MemoryKeys();
      const k = newEd25519();
      const login = await issued(r, { purpose: 'login', kid: 'k1' });
      expect(await r.register({ owner: alice, jwk: k.jwk, proof: { challengeId: login.id, signature: k.sign(`login:${login.nonce}`) } }, ctx)).to.deep.eq({ ok: false, code: 'invalid_proof' });
      const other = newEd25519();
      const c1 = await issued(r, { purpose: 'register', owner: alice });
      expect(await r.register({ owner: alice, jwk: k.jwk, proof: { challengeId: c1.id, signature: other.sign(`register:${c1.nonce}`) } }, ctx)).to.deep.eq({ ok: false, code: 'invalid_proof' });
      const c2 = await issued(r, { purpose: 'register', owner: alice });
      const ok = await r.register({ owner: alice, jwk: k.jwk, name: 'laptop', proof: { challengeId: c2.id, signature: k.sign(`register:${c2.nonce}`) } }, ctx);
      if (!ok.ok) throw new Error(ok.code);
      expect(ok.key.kid).to.eq(thumbprint(k.jwk));
      expect(ok.key.alg).to.eq('EdDSA');
      expect(await r.register({ owner: alice, jwk: k.jwk, proof: { challengeId: c2.id, signature: k.sign(`register:${c2.nonce}`) } }, ctx)).to.deep.eq({ ok: false, code: 'invalid_proof' });
    });

    it('every challenge stands alone, and anonymous login challenges are throttled before anything is stored', async () => {
      const r = new MemoryKeys();
      const k = newEd25519();
      const first = await issued(r, { purpose: 'register', owner: alice });
      await issued(r, { purpose: 'login', kid: 'any' });
      await issued(r, { purpose: 'register', owner: alice });
      expect((await r.register({ owner: alice, jwk: k.jwk, proof: { challengeId: first.id, signature: k.sign(`register:${first.nonce}`) } }, ctx)).ok).to.eq(true);
      const other: AuthnContext = { ...ctx, ip: '10.0.0.2' };
      await issued(r, { purpose: 'login', kid: 'any' }, other);
      await issued(r, { purpose: 'login', kid: 'any' }, other);
      await issued(r, { purpose: 'login', kid: 'any' }, other);
      const before = r.stored;
      expect(await r.challenge({ purpose: 'login', kid: 'any' }, other)).to.deep.eq({ ok: false, retryAfterSeconds: 10 });
      expect(r.stored).to.eq(before);
    });

    it('a JS caller cannot skip the proof for a user either', async () => {
      const r = new MemoryKeys();
      const forged = { owner: alice, jwk: newEd25519().jwk, actor: admin } as unknown as KeyRegistration;
      expect(await r.register(forged, ctx)).to.deep.eq({ ok: false, code: 'invalid_proof' });
    });

    it('an admin registers a service key without a proof; byId, list and owner-bound revoke', async () => {
      const r = new MemoryKeys();
      const k = newEd25519();
      expect(await r.register({ owner: runner, actor: admin, kid: 'bad kid', jwk: k.jwk }, ctx)).to.deep.eq({ ok: false, code: 'invalid_key' });
      const withPrivate = { kty: 'OKP', crv: 'Ed25519', x: k.jwk.x, d: 'secret' } as unknown as PublicJwk;
      expect(await r.register({ owner: runner, actor: admin, jwk: withPrivate }, ctx)).to.deep.eq({ ok: false, code: 'invalid_key' });
      const ok = await r.register({ owner: runner, actor: admin, kid: 'rt-2026-10', jwk: k.jwk, scope: { permissions: ['file:read'] } }, ctx);
      expect(ok.ok).to.eq(true);
      expect(await r.register({ owner: runner, actor: admin, kid: 'rt-2026-11', jwk: k.jwk }, ctx)).to.deep.eq({ ok: false, code: 'duplicate' });
      expect((await r.byId('rt-2026-10'))!.createdBy).to.deep.eq(admin);
      expect(await r.list(runner)).to.have.length(1);
      expect(await r.revoke(alice, 'rt-2026-10', ctx)).to.eq(false);
      expect(await r.revoke({ type: 'user', id: 'runner' }, 'rt-2026-10', ctx)).to.eq(false);
      expect(await r.revoke(runner, 'rt-2026-10', ctx, { actor: admin })).to.eq(true);
      expect((await r.byId('rt-2026-10'))!.revokedAt).to.deep.eq(ctx.now);
      expect(await r.byId('nope')).to.eq(null);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('keys.ts holds KeyRegistry with the design methods', () => {
      expect(shapeOf(classMembers('keys.ts'))).to.deep.eq({
        KeyRegistry: {
          base: null,
          members: [
            { name: 'register', modifiers: ['abstract'], optional: false, params: ['reg', 'ctx'] },
            { name: 'list', modifiers: ['abstract'], optional: false, params: ['owner'] },
            { name: 'revoke', modifiers: ['abstract'], optional: false, params: ['owner', 'kid', 'ctx', 'opts'] },
            { name: 'byId', modifiers: ['abstract'], optional: false, params: ['kid'] },
            { name: 'challenge', modifiers: ['abstract'], optional: false, params: ['req', 'ctx'] },
          ],
        },
      });
    });

    it('KeyAlgorithm lists EdDSA and ES256', () => {
      expect(unionLiterals('keys.ts', 'KeyAlgorithm')).to.deep.eq(['EdDSA', 'ES256']);
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('keys.ts').KeyRegistry;
      expect(c.doc).to.contain('A17');
      const register = docOf(c.members, 'register');
      for (const s of ['POST /user/keys', 'fresh auth', 'A13', 'proof', 'whatever the caller', 'authn:key-add']) expect(register).to.contain(s);
      expect(docOf(c.members, 'list')).to.contain('GET /user/keys');
      for (const s of ['DELETE /user/keys/:kid', 'Owner-bound', 'same type and id', 'IDOR', 'admin', 'next request']) expect(docOf(c.members, 'revoke')).to.contain(s);
      for (const s of ['revoked and expired keys too', 'only without revokedAt and before expiresAt']) expect(docOf(c.members, 'byId')).to.contain(s);
      for (const s of ['POST /auth/keys/challenge', 'anonymous', "counts against the 'login' flow's IP key", 'a refusal stores nothing', 'stands alone', "'key-challenge:<id>'", 'never cancels another', 'Single use', 'short-lived', 'unknown kid', 'A02', 'purpose']) expect(docOf(c.members, 'challenge')).to.contain(s);
      const docs = declarationDocs('keys.ts');
      expect(docs.KeyAlgorithm).to.contain('never read from a token header');
      expect(docs.PublicJwk).to.contain('private');
      expect(docs.KeyRegistration).to.contain("A user's key always needs a proof");
      expect(docs.KeyProof).to.contain('proof of possession');
      const rec = memberDocs('keys.ts', 'KeyRecord');
      expect(rec.kid).to.contain('1–64 of [A-Za-z0-9._-]');
      expect(rec.thumbprint).to.contain('RFC 7638');
      expect(memberDocs('keys.ts', 'NewKey').kid).to.contain('thumbprint');
      expect(memberDocs('keys.ts', 'KeyChallenge').nonce).to.contain('domain separation');
    });
  });

  describe('types', () => {
    it('re-exports the key types from the contracts index', () => {
      same<index.KeyRegistry, KeyRegistry>(true);
      same<index.KeyAlgorithm, KeyAlgorithm>(true);
      same<index.Ed25519PublicJwk, Ed25519PublicJwk>(true);
      same<index.P256PublicJwk, P256PublicJwk>(true);
      same<index.PublicJwk, PublicJwk>(true);
      same<index.KeyMaterial, KeyMaterial>(true);
      same<index.KeyOwner, KeyOwner>(true);
      same<index.KeyRecord, KeyRecord>(true);
      same<index.NewKey, NewKey>(true);
      same<index.KeyProof, KeyProof>(true);
      same<index.KeyRegistration, KeyRegistration>(true);
      same<index.KeyRegisterResult, KeyRegisterResult>(true);
      same<index.KeyChallengeRequest, KeyChallengeRequest>(true);
      same<index.KeyChallenge, KeyChallenge>(true);
      same<index.KeyChallengeResult, KeyChallengeResult>(true);
    });

    it('algorithms, JWKs and owners are closed', () => {
      same<KeyAlgorithm, 'EdDSA' | 'ES256'>(true);
      same<Ed25519PublicJwk, { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string; readonly d?: never }>(true);
      same<P256PublicJwk, { readonly kty: 'EC'; readonly crv: 'P-256'; readonly x: string; readonly y: string; readonly d?: never }>(true);
      same<PublicJwk, Ed25519PublicJwk | P256PublicJwk>(true);
      same<KeyMaterial, { readonly alg: 'EdDSA'; readonly jwk: Ed25519PublicJwk } | { readonly alg: 'ES256'; readonly jwk: P256PublicJwk }>(true);
      same<KeyOwner['type'], 'user' | 'service' | 'agent'>(true);
      same<KeyAlgorithm, KeyRecord['alg']>(true);
      // @ts-expect-error no RSA, no HMAC, no none
      const a: KeyAlgorithm = 'RS256';
      // @ts-expect-error OKP is Ed25519 only
      const b: PublicJwk = { kty: 'OKP', crv: 'P-256', x: 'x' };
      // @ts-expect-error a P-256 key needs y
      const c: PublicJwk = { kty: 'EC', crv: 'P-256', x: 'x' };
      // @ts-expect-error a public JWK never carries the private part
      const d: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' };
      // @ts-expect-error the algorithm follows the key type
      const e: KeyMaterial = { alg: 'ES256', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' } };
      // @ts-expect-error groups own no keys
      const f: KeyOwner = { type: 'group', id: 'g' };
      expect([a, b, c, d, e, f]).to.have.length(6);
    });

    it('records, registrations and challenges have the planned shapes', () => {
      type Fields = {
        readonly kid: string;
        readonly owner: KeyOwner;
        readonly thumbprint: string;
        readonly name?: string;
        readonly scope?: Ceiling;
        readonly createdAt: Date;
        readonly createdBy?: PrincipalRef;
        readonly expiresAt?: Date;
        readonly revokedAt?: Date;
        readonly lastUsedAt?: Date;
      };
      same<Omit<Extract<KeyRecord, { alg: 'EdDSA' }>, 'alg' | 'jwk'>, Fields>(true);
      same<Extract<KeyRecord, { alg: 'EdDSA' }>['jwk'], Ed25519PublicJwk>(true);
      same<Extract<KeyRecord, { alg: 'ES256' }>['jwk'], P256PublicJwk>(true);
      same<NewKey, { readonly kid?: string; readonly jwk: PublicJwk; readonly name?: string; readonly scope?: Ceiling; readonly expiresAt?: Date }>(true);
      same<KeyProof, { readonly challengeId: string; readonly signature: string }>(true);
      same<KeyRegisterResult, { readonly ok: true; readonly key: KeyRecord } | { readonly ok: false; readonly code: 'invalid_key' | 'invalid_proof' | 'duplicate' }>(true);
      same<KeyChallengeRequest, { readonly purpose: 'register'; readonly owner: KeyOwner & { readonly type: 'user' } } | { readonly purpose: 'login'; readonly kid: string }>(true);
      same<KeyChallenge, { readonly id: string; readonly nonce: string; readonly expiresAt: Date }>(true);
      same<KeyChallengeResult, { readonly ok: true; readonly challenge: KeyChallenge } | { readonly ok: false; readonly retryAfterSeconds: number }>(true);
    });

    it('members have the planned types', () => {
      same<Parameters<KeyRegistry['register']>, [KeyRegistration, AuthnContext]>(true);
      same<ReturnType<KeyRegistry['register']>, Promise<KeyRegisterResult>>(true);
      same<Parameters<KeyRegistry['list']>, [IdentityRef]>(true);
      same<ReturnType<KeyRegistry['list']>, Promise<readonly KeyRecord[]>>(true);
      same<Parameters<KeyRegistry['revoke']>, [IdentityRef, string, AuthnContext, { readonly actor?: PrincipalRef }?]>(true);
      same<ReturnType<KeyRegistry['revoke']>, Promise<boolean>>(true);
      same<Parameters<KeyRegistry['byId']>, [string]>(true);
      same<ReturnType<KeyRegistry['byId']>, Promise<KeyRecord | null>>(true);
      same<Parameters<KeyRegistry['challenge']>, [KeyChallengeRequest, AuthnContext]>(true);
      same<ReturnType<KeyRegistry['challenge']>, Promise<KeyChallengeResult>>(true);
    });

    it('the user path cannot skip the proof', () => {
      const jwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x' };
      const proof: KeyProof = { challengeId: 'c', signature: 's' };
      const okUser: KeyRegistration = { owner: alice, jwk, proof };
      const okService: KeyRegistration = { owner: runner, jwk, actor: admin };
      // @ts-expect-error a user's key needs a proof
      const a: KeyRegistration = { owner: alice, jwk };
      // @ts-expect-error an admin actor does not replace a user's proof
      const b: KeyRegistration = { owner: alice, jwk, actor: admin };
      // @ts-expect-error a service key without a proof names the admin or CLI actor
      const c: KeyRegistration = { owner: runner, jwk };
      // @ts-expect-error a register challenge is bound to a user
      const d: KeyChallengeRequest = { purpose: 'register', owner: runner };
      // @ts-expect-error a login challenge names the key
      const e: KeyChallengeRequest = { purpose: 'login' };
      // @ts-expect-error abstract
      const f = () => new KeyRegistry();
      // @ts-expect-error a throttled answer carries retryAfterSeconds
      const g: KeyChallengeResult = { ok: false };
      expect([okUser, okService, a, b, c, d, e, f, g]).to.have.length(9);
    });
  });
});
