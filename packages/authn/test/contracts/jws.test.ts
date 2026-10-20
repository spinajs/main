import * as chai from 'chai';
import 'mocha';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

import { JwsSigner, JwsVerifier } from '../../src/contracts/jws.js';
import type { JwsClaims, JwsErrorCode, JwsHeader, JwsKey, JwsSignOptions, JwsVerification, JwsVerifyOptions } from '../../src/contracts/jws.js';
import type { Ed25519PublicJwk, KeyAlgorithm, KeyRecord, P256PublicJwk } from '../../src/contracts/keys.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, memberDocs, same, shapeOf, unionLiterals } from './source-shape.js';

const expect = chai.expect;

// C8 D4, in its order.
const CODES = ['malformed', 'bad_header', 'unknown_key', 'bad_signature', 'invalid_claims', 'wrong_issuer', 'wrong_audience', 'expired', 'not_yet_valid'] as const;

// RFC 8037 A.1 key, the one C8's tests sign with.
const RFC_D = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
const RFC_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const pub: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: RFC_X };

interface Ticket extends JwsClaims {
  readonly sid: string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const strict = (s: string) => (/^[A-Za-z0-9_-]*$/.test(s) && Buffer.from(s, 'base64url').toString('base64url') === s ? Buffer.from(s, 'base64url') : null);

// An EdDSA-only signer and verifier, to show the contract carries C8's rules.
class MemorySigner extends JwsSigner {
  private readonly key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: RFC_X, d: RFC_D }, format: 'jwk' });
  async sign<C extends JwsClaims>(claims: C, opts: JwsSignOptions): Promise<string> {
    if (opts.kid !== undefined && opts.kid !== 'rfc') throw new Error(`no key ${opts.kid}`);
    const input = `${b64(JSON.stringify({ alg: 'EdDSA', kid: 'rfc', typ: opts.typ }))}.${b64(JSON.stringify(claims))}`;
    return `${input}.${b64(sign(null, Buffer.from(input), this.key))}`;
  }
  async publicKeys(): Promise<readonly JwsKey[]> {
    return [{ kid: 'rfc', alg: 'EdDSA', jwk: pub }];
  }
}

class MemoryVerifier extends JwsVerifier {
  async verify<C extends JwsClaims, K extends JwsKey = JwsKey>(token: string, o: JwsVerifyOptions<C, K>): Promise<JwsVerification<C, K>> {
    const fail = (code: JwsErrorCode): JwsVerification<C, K> => ({ ok: false, code });
    const parts = token.split('.');
    if (parts.length !== 3) return fail('malformed');
    const [h, p, s] = parts.map(strict);
    if (!h || !p || s?.length !== 64) return fail('malformed');
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(h.toString('utf8'));
    } catch {
      return fail('bad_header');
    }
    const names = Object.keys(header ?? {});
    if (names.length !== 3 || !o.algorithms.includes(header.alg as KeyAlgorithm) || typeof header.kid !== 'string' || header.typ !== o.typ) return fail('bad_header');
    const key = await o.keys(header.kid);
    if (!key || key.alg !== header.alg) return fail('unknown_key');
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key.jwk as JsonWebKey, format: 'jwk' }), s)) return fail('bad_signature');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(p.toString('utf8'));
    } catch {
      return fail('invalid_claims');
    }
    const { iss, aud, iat, exp } = payload;
    if (typeof iss !== 'string' || typeof aud !== 'string' || !Number.isInteger(iat) || !Number.isInteger(exp)) return fail('invalid_claims');
    if ((exp as number) <= (iat as number) || (exp as number) - (iat as number) > o.maxLifetimeSeconds) return fail('invalid_claims');
    const claims = o.claims(payload);
    if (claims === null) return fail('invalid_claims');
    if (typeof o.issuer === 'string' ? claims.iss !== o.issuer : !o.issuer(claims.iss, key)) return fail('wrong_issuer');
    if (claims.aud !== o.audience) return fail('wrong_audience');
    const now = Math.floor(o.now.getTime() / 1000);
    if (now >= claims.exp + o.skewSeconds) return fail('expired');
    if (claims.iat > now + o.skewSeconds) return fail('not_yet_valid');
    return { ok: true, header: { alg: key.alg, kid: key.kid, typ: o.typ }, claims, key };
  }
}

const signer = new MemorySigner();
const verifier: JwsVerifier = new MemoryVerifier();
const ticket: Ticket = { iss: 'canvas-api', aud: 'canvas-realtime', sid: 'sess-1', iat: 1_000, exp: 1_300 };
const at = (seconds: number) => new Date(seconds * 1000);
const opts = (over: Partial<JwsVerifyOptions<Ticket>> = {}): JwsVerifyOptions<Ticket> => ({
  typ: 'canvas-rt+jwt',
  algorithms: ['EdDSA'],
  keys: async (kid) => (kid === 'rfc' ? { kid, alg: 'EdDSA', jwk: pub } : null),
  claims: (v) => (typeof v.sid === 'string' ? (v as unknown as Ticket) : null),
  issuer: 'canvas-api',
  audience: 'canvas-realtime',
  now: at(1_100),
  skewSeconds: 30,
  maxLifetimeSeconds: 600,
  ...over,
});
const code = (r: JwsVerification<JwsClaims, JwsKey>) => (r.ok ? 'ok' : r.code);
const forge = (header: object, claims: object) => `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}.${b64(Buffer.alloc(64))}`;

describe('jws contracts', () => {
  describe('runtime', () => {
    it('exports JwsVerifier and JwsSigner from the contracts index as plain abstract classes', () => {
      expect(index.JwsVerifier).to.eq(JwsVerifier);
      expect(index.JwsSigner).to.eq(JwsSigner);
      for (const c of [JwsVerifier, JwsSigner]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('the signer writes { alg, kid, typ } in that order, the claims in the caller order, deterministically', async () => {
      const t = await signer.sign(ticket, { typ: 'canvas-rt+jwt' });
      expect(t).to.eq(await signer.sign(ticket, { typ: 'canvas-rt+jwt', kid: 'rfc' }));
      const [h, p] = t.split('.');
      expect(Buffer.from(h, 'base64url').toString()).to.eq('{"alg":"EdDSA","kid":"rfc","typ":"canvas-rt+jwt"}');
      expect(Buffer.from(p, 'base64url').toString()).to.eq('{"iss":"canvas-api","aud":"canvas-realtime","sid":"sess-1","iat":1000,"exp":1300}');
      expect(await signer.publicKeys()).to.deep.eq([{ kid: 'rfc', alg: 'EdDSA', jwk: pub }]);
      let thrown = '';
      await signer.sign(ticket, { typ: 'canvas-rt+jwt', kid: 'gone' }).catch((e: Error) => (thrown = e.message));
      expect(thrown).to.eq('no key gone');
    });

    it('the verifier accepts within the window and reports the C8 codes at the C8 boundaries', async () => {
      const t = await signer.sign(ticket, { typ: 'canvas-rt+jwt' });
      const ok = await verifier.verify(t, opts());
      expect(ok).to.deep.eq({ ok: true, header: { alg: 'EdDSA', kid: 'rfc', typ: 'canvas-rt+jwt' }, claims: ticket, key: { kid: 'rfc', alg: 'EdDSA', jwk: pub } });
      expect(code(await verifier.verify(t, opts({ now: at(1_329) })))).to.eq('ok');
      expect(code(await verifier.verify(t, opts({ now: at(1_330) })))).to.eq('expired');
      expect(code(await verifier.verify(t, opts({ now: at(969) })))).to.eq('not_yet_valid');
      expect(code(await verifier.verify(t, opts({ now: at(970) })))).to.eq('ok');
    });

    it('reports the first failing check in D4 order', async () => {
      const t = await signer.sign(ticket, { typ: 'canvas-rt+jwt' });
      const [h, p, s] = t.split('.');
      const cases: [string, Partial<JwsVerifyOptions<Ticket>>, JwsErrorCode][] = [
        [`${h}.${p}`, {}, 'malformed'],
        [`${h}.${p}.${s}=`, {}, 'malformed'],
        [forge({ alg: 'EdDSA', kid: 'rfc', typ: 'canvas-rt+jwt', x: 1 }, ticket), {}, 'bad_header'],
        [forge({ alg: 'none', kid: 'rfc', typ: 'canvas-rt+jwt' }, ticket), {}, 'bad_header'],
        [t, { typ: 'spinajs-client+jwt' }, 'bad_header'],
        [t, { algorithms: ['ES256'] }, 'bad_header'],
        [t, { keys: async () => null }, 'unknown_key'],
        [forge({ alg: 'EdDSA', kid: 'rfc', typ: 'canvas-rt+jwt' }, { ...ticket, iss: 'x' }), {}, 'bad_signature'],
        [t, { maxLifetimeSeconds: 299 }, 'invalid_claims'],
        [t, { claims: () => null }, 'invalid_claims'],
        [t, { issuer: 'someone-else', audience: 'nobody', now: at(9_999) }, 'wrong_issuer'],
        [t, { audience: 'nobody', now: at(9_999) }, 'wrong_audience'],
      ];
      for (const [token, over, want] of cases) expect(code(await verifier.verify(token, opts(over))), want).to.eq(want);
    });

    it('takes the algorithm from the key, never from the header', async () => {
      const t = await signer.sign(ticket, { typ: 'canvas-rt+jwt' });
      const es256Key = { kid: 'rfc', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } } as const;
      expect(code(await verifier.verify(t, opts({ algorithms: ['EdDSA', 'ES256'], keys: async () => es256Key })))).to.eq('unknown_key');
    });

    it('an issuer check can depend on the key (assertions: iss = key owner)', async () => {
      const owner = { type: 'service', id: 'runner' } as const;
      const record: KeyRecord = { kid: 'rfc', alg: 'EdDSA', jwk: pub, owner, thumbprint: 't', createdAt: new Date(0) };
      const claims = { iss: 'runner', aud: 'api', iat: 1_000, exp: 1_200, jti: 'j1' };
      const t = await signer.sign(claims, { typ: 'spinajs-client+jwt' });
      const r = await verifier.verify(t, {
        typ: 'spinajs-client+jwt',
        algorithms: ['EdDSA', 'ES256'],
        keys: async (kid) => (kid === record.kid && !record.revokedAt ? record : null),
        claims: (v) => (typeof v.jti === 'string' ? (v as unknown as typeof claims) : null),
        issuer: (iss, key) => iss === key.owner.id,
        audience: 'api',
        now: at(1_100),
        skewSeconds: 30,
        maxLifetimeSeconds: 300,
      });
      if (!r.ok) throw new Error(r.code);
      expect(r.key.owner).to.deep.eq(owner);
      expect(r.claims.jti).to.eq('j1');
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('jws.ts holds JwsVerifier and JwsSigner', () => {
      expect(shapeOf(classMembers('jws.ts'))).to.deep.eq({
        JwsVerifier: { base: null, members: [{ name: 'verify', modifiers: ['abstract'], optional: false, params: ['token', 'opts'] }] },
        JwsSigner: {
          base: null,
          members: [
            { name: 'sign', modifiers: ['abstract'], optional: false, params: ['claims', 'opts'] },
            { name: 'publicKeys', modifiers: ['abstract'], optional: false, params: [] },
          ],
        },
      });
    });

    it('JwsErrorCode lists the nine C8 codes in D4 order', () => {
      expect(unionLiterals('jws.ts', 'JwsErrorCode')).to.deep.eq([...CODES]);
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('jws.ts');
      const verifyDoc = docOf(c.JwsVerifier.members, 'verify');
      for (const s of ['64 bytes', 'exactly { alg, kid, typ }', "the key's own algorithm, never the header's", 'never thrown', 'A17']) expect(verifyDoc).to.contain(s);
      const signDoc = docOf(c.JwsSigner.members, 'sign');
      for (const s of ['{ alg, kid, typ } in that order', "caller's key order", 'deterministic', 'C8 golden tickets', 'byte for byte', 'configuration error']) expect(signDoc).to.contain(s);
      expect(c.JwsSigner.doc).to.contain('private keys');
      expect(c.JwsSigner.doc).to.contain('callers never');
      expect(docOf(c.JwsSigner.members, 'publicKeys')).to.contain('C8 D5');
      const docs = declarationDocs('jws.ts');
      expect(docs.JwsErrorCode).to.contain('D4');
      expect(docs.JwsClaims).to.contain('Unix seconds');
      const o = memberDocs('jws.ts', 'JwsVerifyOptions');
      expect(o.keys).to.contain('Usable keys only');
      expect(o.keys).to.contain('unknown_key');
      expect(o.algorithms).to.contain('bad_header');
      expect(o.claims).to.contain('invalid_claims');
      expect(o.issuer).to.contain('key owner');
      expect(o.now).to.contain('now ≥ exp + skewSeconds');
      expect(o.now).to.contain('iat > now + skewSeconds');
      expect(o.maxLifetimeSeconds).to.contain('invalid_claims');
    });
  });

  describe('types', () => {
    it('re-exports the jws types from the contracts index', () => {
      same<index.JwsVerifier, JwsVerifier>(true);
      same<index.JwsSigner, JwsSigner>(true);
      same<index.JwsErrorCode, JwsErrorCode>(true);
      same<index.JwsHeader, JwsHeader>(true);
      same<index.JwsClaims, JwsClaims>(true);
      same<index.JwsKey, JwsKey>(true);
      same<index.JwsSignOptions, JwsSignOptions>(true);
      same<index.JwsVerifyOptions<Ticket>, JwsVerifyOptions<Ticket>>(true);
      same<index.JwsVerification<Ticket>, JwsVerification<Ticket>>(true);
    });

    it('the code union is exactly the nine C8 codes', () => {
      same<JwsErrorCode, (typeof CODES)[number]>(true);
      // @ts-expect-error no other codes
      const c: JwsErrorCode = 'revoked';
      void c;
    });

    it('headers, claims, keys and options have the planned shapes', () => {
      same<JwsHeader, { readonly alg: KeyAlgorithm; readonly kid: string; readonly typ: string }>(true);
      same<JwsClaims, { readonly iss: string; readonly aud: string; readonly iat: number; readonly exp: number }>(true);
      same<JwsKey, ({ readonly alg: 'EdDSA'; readonly jwk: Ed25519PublicJwk } | { readonly alg: 'ES256'; readonly jwk: P256PublicJwk }) & { readonly kid: string }>(true);
      same<JwsSignOptions, { readonly typ: string; readonly kid?: string }>(true);
      same<
        JwsVerifyOptions<Ticket, KeyRecord>,
        {
          readonly typ: string;
          readonly algorithms: readonly KeyAlgorithm[];
          readonly keys: (kid: string) => Promise<KeyRecord | null>;
          readonly claims: (payload: Readonly<Record<string, unknown>>) => Ticket | null;
          readonly issuer: string | ((iss: string, key: KeyRecord) => boolean);
          readonly audience: string;
          readonly now: Date;
          readonly skewSeconds: number;
          readonly maxLifetimeSeconds: number;
        }
      >(true);
      same<JwsVerification<Ticket, KeyRecord>, { readonly ok: true; readonly header: JwsHeader; readonly claims: Ticket; readonly key: KeyRecord } | { readonly ok: false; readonly code: JwsErrorCode }>(true);
      const record = {} as KeyRecord;
      const asKey: JwsKey = record;
      void asKey;
    });

    it('members have the planned types', () => {
      same<Parameters<JwsSigner['publicKeys']>, []>(true);
      same<ReturnType<JwsSigner['publicKeys']>, Promise<readonly JwsKey[]>>(true);
      type Verify = <C extends JwsClaims, K extends JwsKey = JwsKey>(token: string, opts: JwsVerifyOptions<C, K>) => Promise<JwsVerification<C, K>>;
      type Sign = <C extends JwsClaims>(claims: C, opts: JwsSignOptions) => Promise<string>;
      same<JwsVerifier['verify'], Verify>(true);
      same<JwsSigner['sign'], Sign>(true);
    });

    it('results narrow on ok and carry the caller claims type', async () => {
      const r = await verifier.verify('x', opts());
      // @ts-expect-error claims exist only on success
      void r.claims;
      if (r.ok) same<typeof r.claims, Ticket>(true);
      else same<typeof r.code, JwsErrorCode>(true);
      expect(code(r)).to.eq('malformed');
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new JwsVerifier();
      // @ts-expect-error abstract
      const b = () => new JwsSigner();
      // @ts-expect-error the expected typ is required
      const c: JwsVerifyOptions<Ticket> = { ...opts(), typ: undefined };
      // @ts-expect-error the algorithm list is closed
      const d: JwsVerifyOptions<Ticket> = { ...opts(), algorithms: ['HS256'] };
      // @ts-expect-error the header has no room for other members
      const e: JwsHeader = { alg: 'EdDSA', kid: 'k', typ: 't', jku: 'https://evil' };
      // @ts-expect-error claims without exp cannot be signed
      const f = () => signer.sign({ iss: 'a', aud: 'b', iat: 1 }, { typ: 't' });
      // @ts-expect-error the signer takes no private key from its caller
      const g: JwsSignOptions = { typ: 't', key: { d: RFC_D } };
      expect([a, b, c, d, e, f, g]).to.have.length(7);
    });
  });
});
