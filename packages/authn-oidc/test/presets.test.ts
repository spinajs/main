import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readOidcOptions } from '../src/options/options.js';
import { OidcDiscovery } from '../src/discovery.js';
import { OIDC_PRESETS } from '../src/presets.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeIdp } from './support/fake-idp.js';
import { world } from './support/world.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery');
const recorded = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

const PRESET_CONFIGS: Record<string, Record<string, unknown>> = {
  google: { preset: 'google' },
  entra: { preset: 'entra', tenant: TENANT },
  keycloak: { preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: 'corp' },
  auth0: { preset: 'auth0', domain: 'corp.eu.auth0.com' },
  okta: { preset: 'okta', domain: 'corp.okta.com' },
};

/** A fake IdP that serves the recorded document of `id` at its issuer, with fake keys at its jwks_uri. */
async function idpOf(id: string): Promise<FakeIdp> {
  const doc = recorded(id);
  const idp = await FakeIdp.create(doc.issuer as string);
  idp.discovery = doc;
  return idp;
}

describe('authn-oidc presets', () => {
  for (const [id, config] of Object.entries(PRESET_CONFIGS)) {
    describe(id, () => {
      it('resolves its issuer to the one of the recorded discovery document, which validates', async () => {
        const options = readOidcOptions({ providers: { p: { ...config, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET } } } }, 'production').providers.get('p')!;
        const doc = recorded(id);
        expect(options.issuer).to.eq(doc.issuer);
        const idp = await idpOf(id);
        const meta = await new OidcDiscovery(options.issuer!, idp, false).metadata();
        expect(meta).to.deep.include({ issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, jwks_uri: doc.jwks_uri });
        expect(meta.authorization_response_iss_parameter_supported).to.eq(doc.authorization_response_iss_parameter_supported === true);
      });

      it('logs a linked subject in through the recorded endpoints', async () => {
        const idp = await idpOf(id);
        const w = await world({ idp, provider: config });
        const alice = w.identities.add({ login: 'alice@example.test' });
        await w.links.link(alice, { provider: 'oidc:corp', subject: 'sub-1' });
        const { begun, done } = await w.roundTrip({ claims: { sub: 'sub-1', email: 'alice@example.test', email_verified: true, name: 'Alice', groups: ['eng'] } }, { withIss: true });
        expect(begun.location!.startsWith(recorded(id).authorization_endpoint as string)).to.eq(true);
        expect(done.status, JSON.stringify(done)).to.eq(303);
        const external = w.hook.calls[0][1];
        expect(external.subject).to.eq('sub-1');
        const preset = OIDC_PRESETS[id as keyof typeof OIDC_PRESETS];
        expect(external.emailVerified).to.eq(false, 'the provider linking switch is off, so no email counts as verified');
        expect(Boolean((external.claims as { groups?: unknown }).groups)).to.eq(preset.claims.groups !== null);
      });
    });
  }

  it('google accepts its documented issuer alias in the ID token', async () => {
    const idp = await idpOf('google');
    const w = await world({ idp, provider: { preset: 'google' } });
    const alice = w.identities.add({ login: 'alice@example.test' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'g-1' });
    expect((await w.roundTrip({ claims: { sub: 'g-1' }, override: { iss: 'accounts.google.com' } })).done.status).to.eq(303);
    expect((await w.roundTrip({ claims: { sub: 'g-1' }, override: { iss: 'https://accounts.google.com/' } })).done.status).to.eq(401);
  });

  it('entra never counts its email as verified, even with byVerifiedEmail on', async () => {
    const idp = await idpOf('entra');
    const w = await world({ idp, provider: { preset: 'entra', tenant: TENANT, linking: { byVerifiedEmail: true } }, linking: { jit: false, byVerifiedEmail: true } });
    w.identities.add({ login: 'victim@example.test', email: 'victim@example.test' });
    const { done } = await w.roundTrip({ claims: { sub: 'attacker', email: 'victim@example.test', email_verified: true } });
    expect(done.status).to.eq(401);
  });

  it("entra refuses a token of another tenant's issuer", async () => {
    const idp = await idpOf('entra');
    const w = await world({ idp, provider: { preset: 'entra', tenant: TENANT } });
    const alice = w.identities.add({ login: 'alice@example.test' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'e-1' });
    const other = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0';
    expect((await w.roundTrip({ claims: { sub: 'e-1' }, override: { iss: other } })).done.status).to.eq(401);
  });

  it('keycloak advertises RFC 9207, so a callback without iss fails', async () => {
    const idp = await idpOf('keycloak');
    const w = await world({ idp, provider: PRESET_CONFIGS.keycloak });
    const alice = w.identities.add({ login: 'alice@example.test' });
    await w.links.link(alice, { provider: 'oidc:corp', subject: 'k-1' });
    expect((await w.roundTrip({ claims: { sub: 'k-1' } })).done.status).to.eq(401);
    expect((await w.roundTrip({ claims: { sub: 'k-1' } }, { withIss: true })).done.status).to.eq(303);
  });

  describe('github (plain OAuth2)', () => {
    async function githubWorld(host?: string) {
      const endpoints = OIDC_PRESETS.github.endpoints!;
      const resolved = host ? { authorization: `https://${host}/login/oauth/authorize`, token: `https://${host}/login/oauth/access_token`, userinfo: `https://${host}/api/v3/user` } : endpoints;
      const idp = await FakeIdp.create('https://github.invalid');
      idp.idTokens = false;
      idp.discovery = { ...idp.discovery, authorization_endpoint: resolved.authorization, token_endpoint: resolved.token, userinfo_endpoint: resolved.userinfo };
      const w = await world({ idp, provider: { preset: 'github', ...(host ? { host } : {}) } });
      return { w, idp, resolved };
    }

    it('logs in by the numeric id from userinfo, with no discovery, no ID token and no nonce', async () => {
      const { w, idp, resolved } = await githubWorld();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: '583231' });
      const { begun, done } = await w.roundTrip({ claims: { id: 583231, login: 'octocat', email: 'octo@example.test', name: 'The Octocat' } }, { authorizationEndpoint: resolved.authorization });
      expect(done.status, JSON.stringify(done)).to.eq(303);
      expect(new URL(begun.location!).searchParams.has('nonce')).to.eq(false);
      expect(new URL(begun.location!).searchParams.get('scope')).to.eq('read:user user:email');
      expect(idp.requests.map((r) => r.url)).to.deep.eq([resolved.token, resolved.userinfo]);
      expect(idp.requests[0].form).to.include({ client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET });
      const external = w.hook.calls[0][1];
      expect(external).to.deep.include({ subject: '583231', email: 'octo@example.test', emailVerified: false });
      expect(external.claims).to.not.have.property('groups');
    });

    it('never takes the mutable login as the subject', async () => {
      const { w, resolved } = await githubWorld();
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: 'octocat' });
      expect((await w.roundTrip({ claims: { id: 999, login: 'octocat' } }, { authorizationEndpoint: resolved.authorization })).done.status).to.eq(401);
    });

    it('uses the Enterprise Server endpoints of its host', async () => {
      const { w, idp, resolved } = await githubWorld('github.corp.example');
      const alice = w.identities.add({ login: 'alice@example.test' });
      await w.links.link(alice, { provider: 'oidc:corp', subject: '7' });
      expect((await w.roundTrip({ claims: { id: 7 } }, { authorizationEndpoint: resolved.authorization })).done.status).to.eq(303);
      expect(idp.requests.map((r) => r.url)).to.deep.eq(['https://github.corp.example/login/oauth/access_token', 'https://github.corp.example/api/v3/user']);
    });
  });
});
