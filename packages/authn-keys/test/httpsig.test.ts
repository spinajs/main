import 'mocha';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthnContext, Credentials, KeyOwner, SignedRequest } from '@spinajs/authn/contracts';
import { FakeClock, contentDigest, generateKeyPair, runStrategyConformance, signHttpRequest } from '@spinajs/authn-testing';
import type { HttpSigParams, KitKeyPair } from '@spinajs/authn-testing';
import { digestMatches, parseByteSequenceDictionary, parseSignatureInput } from '../src/httpsig/index.js';
import { signRaw } from '../src/jwk/index.js';
import { keysOptionsFor } from './support/keys-options.js';
import { HttpSignatureStrategy } from '../src/strategies/index.js';
import { keysParts } from './harness.js';

const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'svc' };
const ADMIN = { type: 'user', id: 'admin' };
const TARGET = 'https://api.kit.test/v1/items?x=1';
const BODY = Buffer.from('{"a":1}', 'utf8');

describe('structured fields', () => {
  it('reads one canonical Signature-Input member', () => {
    const v = '("@method" "@target-uri");created=1;expires=2;nonce="n\\"x";keyid="k";alg="ed25519"';
    const s = parseSignatureInput(`sig1=${v}`)!;
    assert.deepStrictEqual({ label: s.label, components: s.components, params: Object.fromEntries(s.params), value: s.value }, { label: 'sig1', components: ['@method', '@target-uri'], params: { created: 1, expires: 2, nonce: 'n"x', keyid: 'k', alg: 'ed25519' }, value: v });
    assert.ok(parseSignatureInput('x-1.*=()'), 'an empty list and any key');
  });

  it('refuses a second member, duplicates, non-canonical text and other value types', () => {
    for (const bad of ['sig1=("@method");created=1, sig2=("@method");created=1', 'sig1=("@method" "@method");created=1', 'sig1=("@method");created=1;created=2', 'sig1=("@method"  "@path");created=1', 'sig1=( "@method");created=1', 'sig1=("@method");created=01', 'sig1=("@method");created=-0', 'sig1=("@method");created=1.5', 'sig1=("@method");created=1234567890123456', 'sig1=("@method");flag', 'sig1=("@method");flag=?1', 'sig1=("@method");tok=abc', 'sig1=("@method";sf);created=1', 'sig1=("@method");nonce="a\\b"', 'sig1=("@method");nonce="ä"', 'Sig1=("@method")', '1sig=("@method")', 'sig1="@method"', 'sig1=("")', '']) {
      assert.strictEqual(parseSignatureInput(bad), null, bad);
    }
  });

  it('reads byte-sequence dictionaries in canonical standard base64 only', () => {
    const m = parseByteSequenceDictionary('sha-256=:AQI=:, sha-512=:AQID:')!;
    assert.deepStrictEqual([...m.keys()], ['sha-256', 'sha-512']);
    for (const bad of ['sha-256=:AQI:', 'sha-256=:AQJ=:', 'sha-256=:AQ-_:', 'sha-256=AQI=', 'sha-256=:AQI=:, sha-256=:AQI=:', 'SHA-256=:AQI=:', '']) {
      assert.strictEqual(parseByteSequenceDictionary(bad), null, bad);
    }
  });

  it('checks Content-Digest members against the body', () => {
    const sha512 = `sha-512=:${createHash('sha512').update(BODY).digest('base64')}:`;
    assert.ok(digestMatches(contentDigest(BODY), BODY));
    assert.ok(digestMatches(`${contentDigest(BODY)}, ${sha512}`, BODY));
    assert.strictEqual(digestMatches(contentDigest(BODY), Buffer.from('x')), false);
    assert.strictEqual(digestMatches(`${contentDigest(BODY)}, md5=:AQI=:`, BODY), false, 'unknown algorithm');
    assert.strictEqual(digestMatches(undefined, BODY), false);
  });
});

async function world(clock = new FakeClock()) {
  const p = await keysParts({}, 'memory');
  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx({ purpose: 'request', ...over });
  const add = async (kp: KitKeyPair = generateKeyPair('EdDSA')) => {
    const r = await p.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk }, ctx());
    assert.ok(r.ok);
    return { kp, kid: r.key.kid };
  };
  const nowS = () => Math.floor(clock.now().getTime() / 1000);
  const signed = (kp: KitKeyPair, kid: string, o: HttpSigParams = {}, req?: Parameters<typeof signHttpRequest>[0]): SignedRequest => signHttpRequest(req ?? { method: 'POST', targetUri: TARGET, headers: { 'content-type': 'application/json' }, body: BODY }, kp, kid, { created: nowS(), expires: nowS() + 300, nonce: randomUUID(), ...o });
  const cred = (request: SignedRequest): Credentials => ({ kind: 'http-signature', request });
  const strategy = p.strategies.find((s) => s instanceof HttpSignatureStrategy) as HttpSignatureStrategy;
  return { p, clock, ctx, add, nowS, signed, cred, strategy };
}

/** Re-signs a request whose Signature-Input text was edited, so only the edit can fail it. */
function resign(req: SignedRequest, kp: KitKeyPair, input: string, components: readonly string[]): SignedRequest {
  const label = input.slice(0, input.indexOf('='));
  const value = input.slice(label.length + 1);
  const values: Record<string, string> = { '@method': req.method.toUpperCase(), '@target-uri': req.targetUri, '@authority': new URL(req.targetUri).host, '@path': new URL(req.targetUri).pathname, '@query': new URL(req.targetUri).search || '?' };
  const base = [...components.map((c) => `"${c}": ${values[c] ?? req.headers[c]?.trim()}`), `"@signature-params": ${value}`].join('\n');
  const sig = signRaw(kp.alg, kp.privateKey, Buffer.from(base, 'utf8')).toString('base64');
  return { ...req, headers: { ...req.headers, 'signature-input': input, signature: `${label}=:${sig}:` } };
}

describe('HttpSignatureStrategy', () => {
  it('fails a request instead of verifying with explicit Options outside the schema ranges', async () => {
    const w = await world();
    const ed = await w.add();
    const options = { ...w.p.options, httpSignature: { ...w.p.options.httpSignature, maxAgeSeconds: Number.NaN } };
    const strategy = new HttpSignatureStrategy(w.p.registry, w.p.nonces, options);
    const outcome = await strategy.verify(w.cred(w.signed(ed.kp, ed.kid, { expires: w.nowS() + 3600 })), w.ctx()).catch((e: unknown) => e);
    assert.ok(outcome instanceof Error && outcome.message.includes('authn.keys.httpSignature.maxAgeSeconds'), JSON.stringify(outcome));
  });

  it('accepts any label, an alg naming the key, and more components', async () => {
    const w = await world();
    const ed = await w.add();
    const ec = await w.add(generateKeyPair('ES256'));
    assert.deepStrictEqual(await w.strategy.verify(w.cred(w.signed(ed.kp, ed.kid, { label: 'client-2' })), w.ctx()), { ok: true, identity: SVC, method: 'http-signature' });
    const n = () => randomUUID();
    const t = w.nowS();
    const withAlg = (kp: KitKeyPair, kid: string, alg: string) => {
      const base = w.signed(kp, kid);
      const input = `sig1=("@method" "@target-uri" "content-digest" "content-type" "@authority" "@path" "@query");created=${t};expires=${t + 300};nonce="${n()}";keyid="${kid}";alg="${alg}"`;
      return resign(base, kp, input, ['@method', '@target-uri', 'content-digest', 'content-type', '@authority', '@path', '@query']);
    };
    assert.ok((await w.strategy.verify(w.cred(withAlg(ed.kp, ed.kid, 'ed25519')), w.ctx())).ok);
    assert.ok((await w.strategy.verify(w.cred(withAlg(ec.kp, ec.kid, 'ecdsa-p256-sha256')), w.ctx())).ok);
    assert.strictEqual((await w.strategy.verify(w.cred(withAlg(ed.kp, ed.kid, 'ecdsa-p256-sha256')), w.ctx())).ok, false, 'alg of another key type');
    assert.strictEqual((await w.strategy.verify(w.cred(withAlg(ed.kp, ed.kid, 'hmac-sha256')), w.ctx())).ok, false, 'an algorithm outside the subset');
  });

  it('refuses two signatures, an unknown parameter, covering the signature headers, and a missing header', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const t = w.nowS();
    const p = (extra = '') => `;created=${t};expires=${t + 300};nonce="${randomUUID()}";keyid="${kid}"${extra}`;
    const two = w.signed(kp, kid);
    const refused: SignedRequest[] = [{ ...two, headers: { ...two.headers, signature: `${two.headers.signature}, sig2=${two.headers.signature.slice(5)}` } }, { ...two, headers: { ...two.headers, signature: two.headers.signature.replace('sig1=', 'sig2=') } }, resign(w.signed(kp, kid), kp, `sig1=("@method" "@target-uri" "content-digest")${p(';tag="x"')}`, ['@method', '@target-uri', 'content-digest']), resign(w.signed(kp, kid), kp, `sig1=("@method" "@target-uri" "content-digest" "x-missing")${p()}`, ['@method', '@target-uri', 'content-digest', 'x-missing']), resign(w.signed(kp, kid), kp, `sig1=("@method" "@target-uri" "content-digest" "@status")${p()}`, ['@method', '@target-uri', 'content-digest', '@status'])];
    const coveringItself = w.signed(kp, kid);
    refused.push(resign(coveringItself, kp, `sig1=("@method" "@target-uri" "content-digest" "signature-input")${p()}`, ['@method', '@target-uri', 'content-digest', 'signature-input']));
    for (const r of refused) {
      assert.deepStrictEqual(await w.strategy.verify(w.cred(r), w.ctx()), { ok: false, reason: 'invalid_credentials' }, r.headers['signature-input']);
    }
  });

  it('checks the time window: created in the future beyond the skew, expires before created', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const t = w.nowS();
    assert.ok((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t + 30, expires: t + 60 })), w.ctx())).ok, 'within the skew');
    assert.strictEqual((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t + 31, expires: t + 60 })), w.ctx())).ok, false);
    assert.strictEqual((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t, expires: t })), w.ctx())).ok, false);
    assert.strictEqual((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t - 10, expires: t })), w.ctx())).ok, false, 'expired at expires');
  });

  it('checks a covered digest without a body against the empty body, and honours extra required components', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const get = w.signed(kp, kid, {}, { method: 'GET', targetUri: TARGET, headers: { 'content-digest': contentDigest(Buffer.alloc(0)) } });
    const t = w.nowS();
    const covered = resign(get, kp, `sig1=("@method" "@target-uri" "content-digest");created=${t};expires=${t + 60};nonce="${randomUUID()}";keyid="${kid}"`, ['@method', '@target-uri', 'content-digest']);
    assert.ok((await w.strategy.verify(w.cred(covered), w.ctx())).ok);
    const lying = { ...covered, headers: { ...covered.headers, 'content-digest': contentDigest(BODY) } };
    assert.strictEqual((await w.strategy.verify(w.cred(lying), w.ctx())).ok, false);

    const strict = new HttpSignatureStrategy(w.p.registry, w.p.nonces, keysOptionsFor({ httpSignature: { requiredComponents: ['@method', '@target-uri', 'content-digest', '@authority'] } }));
    assert.strictEqual((await strict.verify(w.cred(w.signed(kp, kid)), w.ctx())).ok, false, '@authority not covered');
  });

  it('requires content-digest with a body even when the config does not list it; the method and window edges hold', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const lax = new HttpSignatureStrategy(w.p.registry, w.p.nonces, keysOptionsFor({ httpSignature: { requiredComponents: ['@method', '@target-uri'] } }));
    assert.strictEqual((await lax.verify(w.cred(w.signed(kp, kid, { components: ['@method', '@target-uri'] })), w.ctx())).ok, false, 'a body without a covered digest');
    assert.ok((await lax.verify(w.cred(w.signed(kp, kid)), w.ctx())).ok);
    const post = w.signed(kp, kid);
    assert.strictEqual((await w.strategy.verify(w.cred({ ...post, method: 'PUT' }), w.ctx())).ok, false, 'method changed after signing');
    const t = w.nowS();
    assert.ok((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t, expires: t + 1 })), w.ctx())).ok, 'a one-second window');
    assert.ok((await w.strategy.verify(w.cred(w.signed(kp, kid, { created: t - 299, expires: t + 1 })), w.ctx())).ok, 'exactly maxAgeSeconds');
    const mixed = w.signed(kp, kid);
    const upper = Object.fromEntries(Object.entries(mixed.headers).map(([k, v]) => [k.replace(/^./, (c) => c.toUpperCase()), v]));
    assert.ok((await w.strategy.verify(w.cred({ ...mixed, headers: upper }), w.ctx())).ok, 'header names in any case');
  });

  it('a nonce is single use per key; revoked keys fail with their reason; throttle keys come from keyid', async () => {
    const w = await world();
    const a = await w.add();
    const b = await w.add();
    const nonce = randomUUID();
    assert.ok((await w.strategy.verify(w.cred(w.signed(a.kp, a.kid, { nonce })), w.ctx())).ok);
    assert.strictEqual((await w.strategy.verify(w.cred(w.signed(a.kp, a.kid, { nonce })), w.ctx())).ok, false, 'the same nonce, newly signed');
    assert.ok((await w.strategy.verify(w.cred(w.signed(b.kp, b.kid, { nonce })), w.ctx())).ok, 'another key may use it');
    await w.p.registry.revoke(SVC, a.kid, w.ctx());
    assert.deepStrictEqual(await w.strategy.verify(w.cred(w.signed(a.kp, a.kid)), w.ctx()), { ok: false, reason: 'revoked' });
    assert.deepStrictEqual(
      w.strategy.throttleKeys(w.cred(w.signed(a.kp, a.kid)), w.ctx({ ip: '192.0.2.9' })).map((k) => k.value),
      [`key:${a.kid}`, `key:${a.kid}|192.0.2.9`],
    );
    assert.deepStrictEqual(await w.strategy.verify({ kind: 'http-signature', request: { method: 'GET' } } as never, w.ctx()), { ok: false, reason: 'invalid_credentials' });
  });
});

runStrategyConformance(
  async ({ clock }) => {
    const w = await world(clock);
    const { kp, kid } = await w.add();
    const other = generateKeyPair('EdDSA');
    w.p.events.clear();
    return {
      strategy: w.strategy,
      valid: async () => w.cred(w.signed(kp, kid)),
      invalid: async () => w.cred(w.signed(other, kid)),
      unknown: async () => w.cred(w.signed(other, other.kid)),
      sameId: async () => w.cred(w.signed(kp, kid)),
      secretsOf: (c) => [String((c as { request?: SignedRequest }).request?.headers.signature)],
      sessions: { count: async () => (await w.p.sessions.storage.storedKeys()).length },
      events: w.p.events,
    };
  },
  { title: 'authn-keys: HttpSignatureStrategy conformance' },
);
