import 'mocha';
import { expect } from 'chai';
import { generateKeyPairSync } from 'node:crypto';
import { compactVerify, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

import { OidcJwks } from '../src/jwks.js';
import { OidcDiscovery } from '../src/discovery.js';
import { FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';
import type { FakeIdpKey } from './support/fake-idp.js';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(err).to.be.instanceOf(Error);
    return err as Error;
  }
  expect.fail('expected a rejection');
}

async function publicJwkOf(alg: 'RS256' | 'ES256' | 'ES384' | 'EdDSA' | 'PS256', extra: Record<string, unknown> = {}): Promise<JWK> {
  const pair = await generateKeyPair(alg, { extractable: true });
  return { ...(await exportJWK(pair.publicKey)), ...extra };
}

describe('authn-oidc JWKS', () => {
  let idp: FakeIdp;
  let rsa: FakeIdpKey;
  let ed: FakeIdpKey;
  let jwks: OidcJwks;

  beforeEach(async () => {
    idp = await FakeIdp.create();
    [rsa, ed] = idp.keys;
    jwks = new OidcJwks(idp.jwksUri, idp, false);
  });

  /** The key verifies a JWS the IdP signed with the matching private key. */
  async function verifies(key: CryptoKey, signer: FakeIdpKey): Promise<void> {
    const jws = await idp.sign(signer, '{"ok":true}');
    const { payload } = await compactVerify(jws, key, { algorithms: [signer.alg] });
    expect(new TextDecoder().decode(payload)).to.eq('{"ok":true}');
  }

  describe('selection', () => {
    it('selects the key named by kid', async () => {
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0), rsa);
      await verifies(await jwks.key({ alg: 'EdDSA', kid: ed.kid }, T0), ed);
      expect(idp.count(idp.jwksUri)).to.eq(1);
    });

    it('without a kid, selects the single key fitting the alg', async () => {
      await verifies(await jwks.key({ alg: 'EdDSA' }, T0), ed);
      await verifies(await jwks.key({ alg: 'RS256' }, T0), rsa);
    });

    it('without a kid, refuses when several keys fit the alg', async () => {
      await idp.addKey('RS256');
      await rejects(jwks.key({ alg: 'RS256' }, T0));
    });

    it('refuses an alg the key type does not fit', async () => {
      await rejects(jwks.key({ alg: 'ES256', kid: rsa.kid }, T0));
      await rejects(jwks.key({ alg: 'EdDSA', kid: rsa.kid }, T0));
      await rejects(jwks.key({ alg: 'RS256', kid: ed.kid }, T0));
    });

    it("refuses an alg other than the key's own alg", async () => {
      await rejects(jwks.key({ alg: 'PS256', kid: rsa.kid }, T0));
      await rejects(jwks.key({ alg: 'RS384', kid: rsa.kid }, T0));
    });

    it('selects a key without alg for every alg its type fits', async () => {
      idp.jwks = { keys: [await publicJwkOf('PS256', { kid: 'rsa-no-alg' })] };
      expect(await jwks.key({ alg: 'PS256', kid: 'rsa-no-alg' }, T0)).to.have.property('type', 'public');
      expect(await jwks.key({ alg: 'RS512', kid: 'rsa-no-alg' }, T0)).to.have.property('type', 'public');
    });

    it('matches the EC curve to the alg', async () => {
      idp.jwks = { keys: [await publicJwkOf('ES256', { kid: 'p256' }), await publicJwkOf('ES384', { kid: 'p384' })] };
      expect(await jwks.key({ alg: 'ES256', kid: 'p256' }, T0)).to.have.property('type', 'public');
      expect(await jwks.key({ alg: 'ES384' }, T0)).to.have.property('type', 'public');
      await rejects(jwks.key({ alg: 'ES384', kid: 'p256' }, T0));
      await rejects(jwks.key({ alg: 'ES512' }, T0));
    });

    it('refuses none, HMAC and unknown algs', async () => {
      for (const alg of ['none', 'HS256', 'RSA-OAEP', '']) {
        await rejects(jwks.key({ alg, kid: rsa.kid }, T0));
      }
    });
  });

  describe('key checks', () => {
    const served = async (jwk: Record<string, unknown>): Promise<Error> => {
      idp.jwks = { keys: [jwk, rsa.publicJwk] };
      return rejects(jwks.key({ alg: (jwk.alg as string | undefined) ?? 'RS256', kid: jwk.kid as string }, T0));
    };

    it('refuses private key material', async () => {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const priv = pair.privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
      await served({ ...priv, kid: 'private', alg: 'RS256' });
      await served({ ...rsa.publicJwk, kid: 'with-d', d: 'AQAB' });
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
      await served({ ...ec, kid: 'ec-private', alg: 'ES256' });
      await served({ kty: 'oct', k: 'c2VjcmV0', kid: 'oct', alg: 'HS256' });
    });

    it("refuses a key whose use is not 'sig'", async () => {
      await served({ ...rsa.publicJwk, kid: 'enc', use: 'enc' });
      await served({ ...rsa.publicJwk, kid: 'sig-upper', use: 'SIG' });
    });

    it("refuses key_ops other than exactly ['verify']", async () => {
      await served({ ...rsa.publicJwk, kid: 'ops-2', key_ops: ['sign', 'verify'] });
      await served({ ...rsa.publicJwk, kid: 'ops-enc', key_ops: ['encrypt'] });
      await served({ ...rsa.publicJwk, kid: 'ops-str', key_ops: 'verify' });
      idp.jwks = { keys: [{ ...rsa.publicJwk, key_ops: ['verify'] }] };
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0), rsa);
    });

    it('refuses an RSA key under 2048 bits', async () => {
      const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      await served({ ...small, kid: 'rsa-1024', alg: 'RS256' });
      const bits2047 = generateKeyPairSync('rsa', { modulusLength: 2047 }).publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      await served({ ...bits2047, kid: 'rsa-2047', alg: 'RS256' });
    });

    it('refuses an Ed448 key and an unknown key type', async () => {
      const ed448 = generateKeyPairSync('ed448').publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      await served({ ...ed448, kid: 'ed448', alg: 'EdDSA' });
      await served({ kty: 'XYZ', kid: 'xyz', alg: 'RS256' });
    });

    it('a refused key named by kid does not trigger a refresh', async () => {
      idp.jwks = { keys: [{ ...rsa.publicJwk, kid: 'enc', use: 'enc' }] };
      await rejects(jwks.key({ alg: 'RS256', kid: 'enc' }, T0));
      await rejects(jwks.key({ alg: 'RS256', kid: 'enc' }, T0 + 2 * MINUTE));
      expect(idp.count(idp.jwksUri)).to.eq(1);
    });

    it('a refused key does not hide the good keys', async () => {
      idp.jwks = { keys: [{ ...rsa.publicJwk, kid: 'enc', use: 'enc' }, { kty: 'RSA' }, 42, rsa.publicJwk] };
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0), rsa);
      await verifies(await jwks.key({ alg: 'RS256' }, T0), rsa);
    });

    it('refuses a set that is not { keys: [...] }', async () => {
      for (const body of [{ keys: 'x' }, [rsa.publicJwk], { key: [] }]) {
        const other = await FakeIdp.create();
        other.jwks = body as unknown as Record<string, unknown>;
        await rejects(new OidcJwks(other.jwksUri, other, false).key({ alg: 'RS256', kid: other.keys[0].kid }, T0));
      }
      idp.on(idp.jwksUri, () => ({ status: 503, json: { keys: [rsa.publicJwk] } }));
      await rejects(jwks.key({ alg: 'RS256', kid: rsa.kid }, T0));
    });

    it('refuses an http JWKS URI in production and allows it in development or test', async () => {
      const local = await FakeIdp.create('http://localhost:8080/realms/corp');
      await rejects(new OidcJwks(local.jwksUri, local, false).key({ alg: 'RS256', kid: local.keys[0].kid }, T0));
      expect(local.count(local.jwksUri)).to.eq(0);
      expect(await new OidcJwks(local.jwksUri, local, true).key({ alg: 'RS256', kid: local.keys[0].kid }, T0)).to.have.property('type', 'public');
    });
  });

  describe('refresh', () => {
    it('keeps the set 1 h, then fetches it again', async () => {
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0);
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + HOUR - 1);
      expect(idp.count(idp.jwksUri)).to.eq(1);
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + HOUR);
      expect(idp.count(idp.jwksUri)).to.eq(2);
    });

    it('an unknown kid refreshes the set once, then not again within 60 s', async () => {
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0);
      await rejects(jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 10 * SECOND));
      expect(idp.count(idp.jwksUri), 'within a minute of the first fetch').to.eq(1);

      await rejects(jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + MINUTE));
      expect(idp.count(idp.jwksUri)).to.eq(2);
      await rejects(jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 2 * MINUTE - 1));
      await rejects(jwks.key({ alg: 'RS256', kid: 'other' }, T0 + 90 * SECOND));
      expect(idp.count(idp.jwksUri)).to.eq(2);

      const rotated = await idp.addKey('RS256', 'rotated');
      await verifies(await jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 2 * MINUTE), rotated);
      expect(idp.count(idp.jwksUri)).to.eq(3);
      await verifies(await jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 2 * MINUTE + 1), rotated);
      expect(idp.count(idp.jwksUri)).to.eq(3);
    });

    it('without a kid, no fitting key refreshes the set under the same limit', async () => {
      idp.jwks = { keys: [rsa.publicJwk] };
      await jwks.key({ alg: 'RS256' }, T0);
      await rejects(jwks.key({ alg: 'EdDSA' }, T0 + MINUTE));
      expect(idp.count(idp.jwksUri)).to.eq(2);
      await rejects(jwks.key({ alg: 'EdDSA' }, T0 + MINUTE + 1));
      expect(idp.count(idp.jwksUri)).to.eq(2);
    });

    it('a failed refresh keeps the set and is not retried within 60 s', async () => {
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0);
      idp.fail(idp.jwksUri);
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + HOUR), rsa);
      expect(idp.count(idp.jwksUri)).to.eq(2);
      await rejects(jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + HOUR + MINUTE - 1));
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + HOUR + MINUTE - 1), rsa);
      expect(idp.count(idp.jwksUri)).to.eq(2);
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + HOUR + MINUTE), rsa);
      expect(idp.count(idp.jwksUri)).to.eq(3);
    });

    it('with no set, a failed fetch fails and is not retried within 60 s', async () => {
      idp.fail(idp.jwksUri);
      await rejects(jwks.key({ alg: 'RS256', kid: rsa.kid }, T0));
      idp.restore(idp.jwksUri);
      await rejects(jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + MINUTE - 1));
      expect(idp.count(idp.jwksUri)).to.eq(1);
      await verifies(await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0 + MINUTE), rsa);
      expect(idp.count(idp.jwksUri)).to.eq(2);
    });

    it('shares one fetch between concurrent first callers', async () => {
      const release = idp.hold(idp.jwksUri);
      const pending = [jwks.key({ alg: 'RS256', kid: rsa.kid }, T0), jwks.key({ alg: 'EdDSA', kid: ed.kid }, T0), jwks.key({ alg: 'RS256' }, T0)];
      release();
      await Promise.all(pending);
      expect(idp.count(idp.jwksUri)).to.eq(1);
    });

    it('shares one refresh between concurrent callers with an unknown kid', async () => {
      await jwks.key({ alg: 'RS256', kid: rsa.kid }, T0);
      const rotated = await idp.addKey('RS256', 'rotated');
      const release = idp.hold(idp.jwksUri);
      const pending = [jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 2 * MINUTE), jwks.key({ alg: 'RS256', kid: 'rotated' }, T0 + 2 * MINUTE)];
      release();
      for (const key of await Promise.all(pending)) {
        await verifies(key, rotated);
      }
      expect(idp.count(idp.jwksUri)).to.eq(2);
    });

    it('takes the JWKS URI from discovery when given a resolver', async () => {
      const discovery = new OidcDiscovery(FAKE_ISSUER, idp, false);
      const fromDiscovery = new OidcJwks((now) => discovery.metadata(now).then((d) => d.jwks_uri), idp, false);
      await verifies(await fromDiscovery.key({ alg: 'RS256', kid: rsa.kid }, T0), rsa);
      expect(idp.requests.map((r) => r.url)).to.deep.eq([idp.discoveryUrl, idp.jwksUri]);
    });
  });
});
