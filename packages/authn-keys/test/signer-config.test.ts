import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import { JwsSigner } from '@spinajs/authn/contracts';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { generateKeyPair } from '@spinajs/authn-testing';

import { AUTHN_KEYS_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { AuthnKeysSignerBootstrapper, LocalJwsSigner, StrictJwsVerifier, registerJwsSigner } from '../src/jws/index.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';
import { privateJwkOf } from './harness.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_KEYS_CONFIGURATION_SCHEMA];
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const TYP = 'signer-config+jwt';
const AUDIENCE = 'https://signer.example.test';

const secretOf = (kid: string, alg: 'EdDSA' | 'ES256' = 'EdDSA') => JSON.stringify(privateJwkOf(generateKeyPair(alg), kid));
const signerConfig = (signer: unknown) => ({ authn: { keys: { signer } } });
const bad = (signer: unknown) => violationsOf(SCHEMAS, signerConfig(signer));

async function booted(signer: unknown): Promise<IContainer> {
  const { child } = await boot(SCHEMAS, signerConfig(signer));
  return child;
}

function headerOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
}

const claims = () => {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: 'signer-config', aud: AUDIENCE, iat, exp: iat + 60 };
};

describe('authn.keys.signer', () => {
  afterEach(disposeBooted);

  describe('configuration', () => {
    it('defaults to null', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.keys.signer')).to.eq(null);
    });

    it('keeps a configured signer', async () => {
      const keys = [secretOf('k1'), secretOf('k2')];
      const { configuration } = await boot(SCHEMAS, signerConfig({ current: 'k2', keys }));
      expect(configuration.get('authn.keys.signer')).to.deep.eq({ current: 'k2', keys });
    });

    it('refuses a signer without current, without keys, with no keys or with an empty reference', async () => {
      const k = secretOf('k1');
      const cases: unknown[] = [{ keys: [k] }, { current: 'k1' }, { current: 'k1', keys: [] }, { current: 'k1', keys: [''] }, { current: '', keys: [k] }];
      for (const signer of cases) {
        const paths = await bad(signer);
        expect(
          paths.some((p) => p.startsWith('authn.keys.signer')),
          JSON.stringify(signer),
        ).to.eq(true);
      }
    });
  });

  describe('registerJwsSigner', () => {
    it('two keys with current k2 register a JwsSigner that signs with k2', async () => {
      const container = await booted({ current: 'k2', keys: [secretOf('k1'), secretOf('k2', 'ES256')] });
      await registerJwsSigner(container);

      expect(container.hasRegistered(JwsSigner, false)).to.eq(true);
      const signer = await container.resolve(JwsSigner);
      const token = await signer.sign(claims(), { typ: TYP });
      expect(headerOf(token)).to.deep.eq({ alg: 'ES256', kid: 'k2', typ: TYP });
      expect(headerOf(await signer.sign(claims(), { typ: TYP, kid: 'k1' })).kid).to.eq('k1');
    });

    it('the signer is a LocalJwsSigner and its tokens verify against its own public keys', async () => {
      const container = await booted({ current: 'k1', keys: [secretOf('k1'), secretOf('k2')] });
      await registerJwsSigner(container);
      const signer = await container.resolve(JwsSigner);
      expect(signer).to.be.instanceOf(LocalJwsSigner);

      const keys = new Map((await signer.publicKeys()).map((key) => [key.kid, key]));
      const verified = await new StrictJwsVerifier().verify(await signer.sign(claims(), { typ: TYP }), {
        typ: TYP,
        algorithms: ['EdDSA', 'ES256'],
        keys: async (kid) => keys.get(kid) ?? null,
        claims: (payload) => payload as unknown as ReturnType<typeof claims>,
        issuer: 'signer-config',
        audience: AUDIENCE,
        now: new Date(),
        skewSeconds: 30,
        maxLifetimeSeconds: 300,
      });
      expect(verified.ok).to.eq(true);
    });

    it('publicKeys lists k1 and k2 without any private member', async () => {
      const container = await booted({ current: 'k2', keys: [secretOf('k1'), secretOf('k2', 'ES256')] });
      await registerJwsSigner(container);
      const keys = await (await container.resolve(JwsSigner)).publicKeys();

      expect(keys.map((k) => k.kid)).to.have.members(['k1', 'k2']);
      for (const key of keys) {
        for (const member of PRIVATE_MEMBERS) {
          expect(key.jwk, `${key.kid}.${member}`).to.not.have.property(member);
          expect(JSON.stringify(key), `${key.kid}.${member}`).to.not.contain(`"${member}":`);
        }
      }
    });

    it('a null signer registers nothing', async () => {
      const container = await booted(null);
      expect(await registerJwsSigner(container)).to.eq(null);
      expect(container.hasRegistered(JwsSigner, false)).to.eq(false);
    });

    it('no signer in the configuration registers nothing', async () => {
      const { child } = await boot(SCHEMAS, {});
      expect(await registerJwsSigner(child)).to.eq(null);
      expect(child.hasRegistered(JwsSigner, false)).to.eq(false);
    });

    it('fails when current is not one of the keys', async () => {
      const container = await booted({ current: 'k9', keys: [secretOf('k1')] });
      let error: unknown;
      await registerJwsSigner(container).catch((e: unknown) => (error = e));
      expect(String(error)).to.contain('k9');
      expect(container.hasRegistered(JwsSigner, false)).to.eq(false);
    });

    it('fails on a reference that is not a private JWK, naming its position and never its value', async () => {
      const secret = 'not-json-super-secret-value';
      const container = await booted({ current: 'k1', keys: [secretOf('k1'), secret] });
      let error: unknown;
      await registerJwsSigner(container).catch((e: unknown) => (error = e));
      expect(String(error)).to.contain('authn.keys.signer.keys.1');
      expect(String(error)).to.not.contain(secret);
      expect(container.hasRegistered(JwsSigner, false)).to.eq(false);
    });

    it('fails on a public-only JWK without leaking the key', async () => {
      const publicOnly = Object.fromEntries(Object.entries(privateJwkOf(generateKeyPair('EdDSA'), 'k1')).filter(([member]) => member !== 'd'));
      const container = await booted({ current: 'k1', keys: [JSON.stringify(publicOnly)] });
      let error: unknown;
      await registerJwsSigner(container).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(Error);
      expect(container.hasRegistered(JwsSigner, false)).to.eq(false);
    });

    it('fails on a repeated kid', async () => {
      const container = await booted({ current: 'k1', keys: [secretOf('k1'), secretOf('k1')] });
      let error: unknown;
      await registerJwsSigner(container).catch((e: unknown) => (error = e));
      expect(String(error)).to.contain('twice');
    });
  });

  describe('AuthnKeysSignerBootstrapper', () => {
    it('registers the configured signer in its container', async () => {
      const container = await booted({ current: 'k1', keys: [secretOf('k1')] });
      const bootstrapper = new AuthnKeysSignerBootstrapper();
      (bootstrapper as unknown as { Container: IContainer }).Container = container;
      await bootstrapper.bootstrap();
      expect(container.hasRegistered(JwsSigner, false)).to.eq(true);
    });

    it('registers nothing without a signer', async () => {
      const container = await booted(null);
      const bootstrapper = new AuthnKeysSignerBootstrapper();
      (bootstrapper as unknown as { Container: IContainer }).Container = container;
      await bootstrapper.bootstrap();
      expect(container.hasRegistered(JwsSigner, false)).to.eq(false);
    });
  });
});
