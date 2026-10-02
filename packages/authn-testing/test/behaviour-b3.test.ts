import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_RULES, planCases, runAuthnBehaviour, settleCase } from '../src/behaviour/index.js';
import type { HarnessFactory, PlannedCase } from '../src/behaviour/index.js';
import { b64url, generateKeyPair } from '../src/helpers/index.js';
import { ReferenceJwsSigner, ReferenceJwsVerifier } from './reference/jws-verifier.js';

// A17/jws on the reference verifier; both signature algorithms for the signer case.
for (const alg of ['EdDSA', 'ES256'] as const) {
  runAuthnBehaviour(['A17'], () => ({ jws: { verifier: new ReferenceJwsVerifier(), signer: new ReferenceJwsSigner([generateKeyPair(alg)]) } }), {
    title: `reference verifier: A17 jws facet (${alg} signer)`,
    facets: ['A17/jws'],
    claim: ['A17/jws'],
  });
}

type Verify = ReferenceJwsVerifier['verify'];

/** Normalises every part to strict base64url before the reference sees it. */
class LenientBase64 extends ReferenceJwsVerifier {
  override verify: Verify = (token, opts) =>
    super.verify(
      token
        .split('.')
        .map((p) => p.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))
        .join('.'),
      opts,
    );
}

const readInt = (der: Buffer, at: number): { value: Buffer; next: number } => {
  const length = der[at + 1];
  const raw = der.subarray(at + 2, at + 2 + length);
  const trimmed = raw[0] === 0 ? raw.subarray(1) : raw;
  return { value: Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]), next: at + 2 + length };
};

/** Accepts DER ECDSA signatures by converting them to the 64-byte form. */
class AcceptsDer extends ReferenceJwsVerifier {
  override verify: Verify = (token, opts) => {
    const [h, p, s] = token.split('.');
    const sig = Buffer.from(s, 'base64url');
    if (sig.length > 64 && sig[0] === 0x30) {
      const r = readInt(sig, 2);
      const t = readInt(sig, r.next);
      return super.verify(`${h}.${p}.${b64url(Buffer.concat([r.value, t.value]))}`, opts);
    }
    return super.verify(token, opts);
  };
}

type Payload = { iss: string; aud: string; iat: number; exp: number };

/** Checks one claim group before the reference's own order, so two rows of the check order swap. */
const earlyCheck = (decide: (c: Payload, nowS: number, skew: number, issuer: unknown, audience: string) => string | null) =>
  class extends ReferenceJwsVerifier {
    override verify: Verify = (token, opts) => {
      const c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Payload;
      const code = decide(c, Math.floor(opts.now.getTime() / 1000), opts.skewSeconds, opts.issuer, opts.audience);
      return code ? Promise.resolve({ ok: false, code } as never) : super.verify(token, opts);
    };
  };

const IssuerBeforeClaims = earlyCheck((c, _n, _s, issuer) => (typeof issuer === 'string' && c.iss !== issuer ? 'wrong_issuer' : null));
const AudienceBeforeIssuer = earlyCheck((c, _n, _s, _i, audience) => (c.aud !== audience ? 'wrong_audience' : null));
const ExpiryBeforeAudience = earlyCheck((c, nowS, skew) => (nowS >= c.exp + skew ? 'expired' : null));

const factory =
  (verifier: ReferenceJwsVerifier): HarnessFactory =>
  () => ({ jws: { verifier, signer: new ReferenceJwsSigner([generateKeyPair('EdDSA')]) } });

const byName = (name: string): PlannedCase => {
  const hits = planCases(['A17']).filter((p) => p.kase.name === name);
  assert.strictEqual(hits.length, 1, `exactly one case named ${name}`);
  assert.ok(AUTHN_RULES.get('A17')!.cases.includes(hits[0].kase));
  return hits[0];
};

async function bites(name: string, mutant: ReferenceJwsVerifier): Promise<void> {
  const p = byName(name);
  const good = await settleCase(p, factory(new ReferenceJwsVerifier()));
  assert.strictEqual(good.status, 'passed', `${name} on the reference: ${String(good.error)}`);
  assert.strictEqual((await settleCase(p, factory(mutant))).status, 'failed', `${name} on the mutant`);
}

describe('mutation checks A17/jws', function () {
  this.timeout(60_000);

  it('lenient base64 decoding fails the strict decoding rows', async () => {
    await bites('A17 JwsVerifier reports malformed: bad base64url', new LenientBase64());
    await bites('A17 JwsVerifier reports malformed: trailing =', new LenientBase64());
  });
  it('accepting DER signatures fails the DER row', () => bites('A17 JwsVerifier reports malformed: ES256 DER signature', new AcceptsDer()));
  it('issuer before claims fails its order row', () => bites('A17 JwsVerifier reports invalid_claims: lifetime over max beats wrong issuer', new IssuerBeforeClaims()));
  it('audience before issuer fails its order row', () => bites('A17 JwsVerifier reports wrong_issuer: wrong issuer beats wrong audience', new AudienceBeforeIssuer()));
  it('expiry before audience fails its order row', () => bites('A17 JwsVerifier reports wrong_audience: wrong audience beats expired', new ExpiryBeforeAudience()));
});
