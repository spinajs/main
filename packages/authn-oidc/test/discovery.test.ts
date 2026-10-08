import 'mocha';
import { expect } from 'chai';

import { OidcDiscovery } from '../src/discovery.js';
import { FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';

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

describe('authn-oidc discovery', () => {
  let idp: FakeIdp;
  let discovery: OidcDiscovery;

  beforeEach(() => {
    idp = new FakeIdp();
    discovery = new OidcDiscovery(FAKE_ISSUER, idp, false);
  });

  describe('document', () => {
    it('fetches <issuer>/.well-known/openid-configuration and returns the validated document', async () => {
      const doc = await discovery.metadata(T0);
      expect(idp.requests.map((r) => [r.method, r.url])).to.deep.eq([['GET', `${FAKE_ISSUER}/.well-known/openid-configuration`]]);
      expect(doc).to.deep.eq({
        issuer: FAKE_ISSUER,
        authorization_endpoint: idp.discovery.authorization_endpoint,
        token_endpoint: idp.discovery.token_endpoint,
        jwks_uri: idp.discovery.jwks_uri,
        userinfo_endpoint: idp.discovery.userinfo_endpoint,
        authorization_response_iss_parameter_supported: false,
      });
      expect(Object.isFrozen(doc)).to.eq(true);
    });

    it('does not double the slash of an issuer that ends with one', async () => {
      const issuer = 'https://corp.eu.auth0.com/';
      const auth0 = new FakeIdp(issuer);
      await new OidcDiscovery(issuer, auth0, false).metadata(T0);
      expect(auth0.requests.map((r) => r.url)).to.deep.eq(['https://corp.eu.auth0.com/.well-known/openid-configuration']);
    });

    it('reads the RFC 9207 iss parameter flag, true only for a boolean true', async () => {
      idp.discovery.authorization_response_iss_parameter_supported = true;
      expect((await discovery.metadata(T0)).authorization_response_iss_parameter_supported).to.eq(true);
      for (const flag of ['true', 1]) {
        const other = new FakeIdp();
        other.discovery.authorization_response_iss_parameter_supported = flag;
        expect((await new OidcDiscovery(FAKE_ISSUER, other, false).metadata(T0)).authorization_response_iss_parameter_supported).to.eq(false);
      }
    });

    it('accepts a document without a userinfo endpoint or the optional lists', async () => {
      delete idp.discovery.userinfo_endpoint;
      delete idp.discovery.response_types_supported;
      delete idp.discovery.code_challenge_methods_supported;
      const doc = await discovery.metadata(T0);
      expect(doc).to.not.have.property('userinfo_endpoint');
    });

    it('drops members the flow does not use', async () => {
      idp.discovery.end_session_endpoint = `${FAKE_ISSUER}/logout`;
      expect(await discovery.metadata(T0)).to.not.have.property('end_session_endpoint');
    });
  });

  describe('refusals', () => {
    const refusedWith = async (change: (doc: Record<string, unknown>) => void, env = false): Promise<void> => {
      const other = new FakeIdp();
      change(other.discovery);
      await rejects(new OidcDiscovery(FAKE_ISSUER, other, env).metadata(T0));
    };

    it('refuses an issuer that differs from the configured one', async () => {
      await refusedWith((d) => (d.issuer = `${FAKE_ISSUER}/`));
      await refusedWith((d) => (d.issuer = 'https://evil.example.test/realms/corp'));
      await refusedWith((d) => (d.issuer = FAKE_ISSUER.toUpperCase()));
      await refusedWith((d) => delete d.issuer);
    });

    it('refuses a missing or relative endpoint', async () => {
      for (const member of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        await refusedWith((d) => delete d[member]);
        await refusedWith((d) => (d[member] = '/protocol/openid-connect/x'));
        await refusedWith((d) => (d[member] = 42));
      }
      await refusedWith((d) => (d.userinfo_endpoint = 'userinfo'));
      await refusedWith((d) => (d.userinfo_endpoint = null));
    });

    it('refuses an http endpoint in production and allows it in development or test', async () => {
      for (const member of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint']) {
        await refusedWith((d) => (d[member] = 'http://idp.example.test/x'));
      }
      const local = new FakeIdp('http://localhost:8080/realms/corp');
      const doc = await new OidcDiscovery('http://localhost:8080/realms/corp', local, true).metadata(T0);
      expect(doc.jwks_uri).to.eq('http://localhost:8080/realms/corp/protocol/openid-connect/certs');
      await refusedWith((d) => (d.jwks_uri = 'ftp://idp.example.test/x'), true);
    });

    it('refuses a provider without the code response type or PKCE S256 when it lists them', async () => {
      await refusedWith((d) => (d.response_types_supported = ['id_token', 'token id_token']));
      await refusedWith((d) => (d.response_types_supported = 'code'));
      await refusedWith((d) => (d.code_challenge_methods_supported = ['plain']));
      await refusedWith((d) => (d.code_challenge_methods_supported = 'S256'));
    });

    it('refuses an answer other than a 200 JSON object', async () => {
      idp.on(idp.discoveryUrl, () => ({ status: 500, json: idp.discovery }));
      await rejects(discovery.metadata(T0));
      const other = new FakeIdp();
      other.on(other.discoveryUrl, () => ({ status: 200, json: [other.discovery] }));
      await rejects(new OidcDiscovery(FAKE_ISSUER, other, false).metadata(T0));
    });
  });

  describe('cache', () => {
    it('answers from the cache within 1 h and refreshes after', async () => {
      await discovery.metadata(T0);
      await discovery.metadata(T0 + HOUR - 1);
      expect(idp.count(idp.discoveryUrl)).to.eq(1);
      idp.discovery.token_endpoint = `${FAKE_ISSUER}/token2`;
      expect((await discovery.metadata(T0 + HOUR)).token_endpoint).to.eq(`${FAKE_ISSUER}/token2`);
      expect(idp.count(idp.discoveryUrl)).to.eq(2);
    });

    it('keeps the cached document when a refresh fails and retries at most once a minute', async () => {
      const first = await discovery.metadata(T0);
      idp.fail(idp.discoveryUrl);
      expect(await discovery.metadata(T0 + HOUR)).to.eq(first);
      expect(idp.count(idp.discoveryUrl)).to.eq(2);
      expect(await discovery.metadata(T0 + HOUR + MINUTE - 1)).to.eq(first);
      expect(idp.count(idp.discoveryUrl)).to.eq(2);
      expect(await discovery.metadata(T0 + HOUR + MINUTE)).to.eq(first);
      expect(idp.count(idp.discoveryUrl)).to.eq(3);
      idp.restore(idp.discoveryUrl);
      idp.discovery.token_endpoint = `${FAKE_ISSUER}/token2`;
      expect((await discovery.metadata(T0 + HOUR + 2 * MINUTE)).token_endpoint).to.eq(`${FAKE_ISSUER}/token2`);
      expect(idp.count(idp.discoveryUrl)).to.eq(4);
    });

    it('keeps the cached document when a refresh answers an invalid one', async () => {
      const first = await discovery.metadata(T0);
      idp.discovery.issuer = 'https://evil.example.test';
      expect(await discovery.metadata(T0 + HOUR)).to.eq(first);
    });

    it('fails with no document and retries at most once a minute', async () => {
      idp.fail(idp.discoveryUrl);
      await rejects(discovery.metadata(T0));
      idp.restore(idp.discoveryUrl);
      await rejects(discovery.metadata(T0 + MINUTE - 1));
      expect(idp.count(idp.discoveryUrl)).to.eq(1);
      await discovery.metadata(T0 + MINUTE);
      expect(idp.count(idp.discoveryUrl)).to.eq(2);
    });

    it('shares one fetch between concurrent first callers', async () => {
      const release = idp.hold(idp.discoveryUrl);
      const pending = [discovery.metadata(T0), discovery.metadata(T0), discovery.metadata(T0 + SECOND)];
      release();
      const docs = await Promise.all(pending);
      expect(idp.count(idp.discoveryUrl)).to.eq(1);
      expect(docs[1]).to.eq(docs[0]);
      expect(docs[2]).to.eq(docs[0]);
    });

    it('shares one failing fetch between concurrent first callers', async () => {
      idp.fail(idp.discoveryUrl);
      const release = idp.hold(idp.discoveryUrl);
      const pending = [rejects(discovery.metadata(T0)), rejects(discovery.metadata(T0))];
      release();
      await Promise.all(pending);
      expect(idp.count(idp.discoveryUrl)).to.eq(1);
    });

    it('reads the time from Date when no time is given', async () => {
      await discovery.metadata();
      await discovery.metadata();
      expect(idp.count(idp.discoveryUrl)).to.eq(1);
    });
  });
});
