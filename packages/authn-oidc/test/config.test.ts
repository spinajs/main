import 'mocha';
import { expect } from 'chai';
import AjvModule from 'ajv';
import { InvalidOption } from '@spinajs/exceptions';

import { OIDC_SIGNING_ALGORITHMS } from '../src/contracts.js';
import type { OidcProviderSource } from '../src/contracts.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA, AUTHN_OIDC_PROVIDER_SCHEMA, OIDC_RESERVED_PARAMS } from '../src/options/schema.js';
import { readOidcOptions } from '../src/options/options.js';
import type { OidcOptions, OidcProviderOptions } from '../src/options/options.js';
import { OIDC_PRESETS, resolveEndpoints, resolveIssuer } from '../src/presets.js';

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts?: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null } };

const SECRET = 'SUPER-SECRET-VALUE-42';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const ISSUER = 'https://idp.example.test/realms/corp';

const client = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ clientId: 'canvas', clientSecret: { secret: SECRET }, ...over });
const generic = (over: Record<string, unknown> = {}): Record<string, unknown> => client({ issuer: ISSUER, ...over });
const read = (providers: Record<string, unknown>, env?: string, rest: Record<string, unknown> = {}): OidcOptions => readOidcOptions({ providers, ...rest }, env);
const one = (provider: Record<string, unknown>, env?: string, name = 'corp'): OidcProviderOptions => read({ [name]: provider }, env).providers.get(name)!;

/** Asserts an InvalidOption naming the provider and every given key, and never the secret. */
function refused(fn: () => unknown, ...mentions: string[]): string {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error, 'expected a refusal').to.be.instanceOf(InvalidOption);
  const message = (error as Error).message;
  for (const m of mentions) {
    expect(message, message).to.contain(m);
  }
  expect(message).to.not.contain(SECRET);
  return message;
}

const refusedProvider = (provider: Record<string, unknown>, key: string, env?: string): string => refused(() => one(provider, env), 'corp', key);

describe('authn-oidc config', () => {
  describe('defaults', () => {
    it('reads an absent authn.oidc as no providers with the default redirects', () => {
      for (const raw of [undefined, null, {}]) {
        const options = readOidcOptions(raw, undefined);
        expect(options.providers.size).to.eq(0);
        expect(options.redirects).to.deep.eq({ success: '/', failure: '/' });
      }
    });

    it('fills every default of a generic provider configured by its issuer only', () => {
      const p = one(generic());
      expect(p).to.deep.eq({
        name: 'corp',
        strategy: 'oidc:corp',
        preset: null,
        source: { issuer: ISSUER },
        idToken: true,
        issuer: ISSUER,
        issuerAliases: [],
        endpoints: null,
        clientId: 'canvas',
        clientSecret: { secret: SECRET },
        tokenEndpointAuth: 'client_secret_basic',
        redirectUri: null,
        scopes: ['openid', 'email', 'profile'],
        claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', groups: 'groups' },
        algorithms: [...OIDC_SIGNING_ALGORITHMS],
        clockSkewSeconds: 30,
        userinfo: 'auto',
        requiredClaims: {},
        authorizationParams: {},
        linking: { jit: false, byVerifiedEmail: false },
      });
      expect(Object.isFrozen(p)).to.eq(true);
      expect(Object.isFrozen(p.claims)).to.eq(true);
      expect(Object.isFrozen(p.scopes)).to.eq(true);
    });

    it('keeps the configured values', () => {
      const p = one(
        generic({
          tokenEndpointAuth: 'client_secret_post',
          redirectUri: 'https://app.example.test/auth/oidc/corp/callback',
          scopes: ['openid', 'groups'],
          claims: { groups: ['realm_access', 'roles'], name: null },
          algorithms: ['EdDSA', 'RS256'],
          clockSkewSeconds: 0,
          userinfo: false,
          requiredClaims: { hd: 'example.com', tier: 2, staff: true },
          authorizationParams: { prompt: 'select_account' },
          linking: { jit: true },
        }),
      );
      expect(p.tokenEndpointAuth).to.eq('client_secret_post');
      expect(p.redirectUri).to.eq('https://app.example.test/auth/oidc/corp/callback');
      expect(p.scopes).to.deep.eq(['openid', 'groups']);
      expect(p.claims).to.deep.eq({ subject: 'sub', email: 'email', emailVerified: 'email_verified', name: null, groups: ['realm_access', 'roles'] });
      expect(p.algorithms).to.deep.eq(['EdDSA', 'RS256']);
      expect(p.clockSkewSeconds).to.eq(0);
      expect(p.userinfo).to.eq(false);
      expect(p.requiredClaims).to.deep.eq({ hd: 'example.com', tier: 2, staff: true });
      expect(p.authorizationParams).to.deep.eq({ prompt: 'select_account' });
      expect(p.linking).to.deep.eq({ jit: true, byVerifiedEmail: false });
    });

    it("gives an ID token provider 'openid' when its scopes lack it", () => {
      expect(one(generic({ scopes: ['email'] })).scopes).to.deep.eq(['openid', 'email']);
      expect(one(client({ preset: 'google', scopes: [] })).scopes).to.deep.eq(['openid']);
      expect(one(client({ preset: 'github', scopes: ['read:user'] })).scopes).to.deep.eq(['read:user']);
    });

    it("merges the claims mapping member by member over the preset's", () => {
      const p = one(client({ preset: 'github', claims: { email: null } }));
      expect(p.claims).to.deep.eq({ ...OIDC_PRESETS.github.claims, email: null });
      expect(p.claims.subject).to.eq('id');
    });

    it('takes the preset scopes and token endpoint auth, which the config overrides', () => {
      const gh = one(client({ preset: 'github' }));
      expect(gh.scopes).to.deep.eq([...OIDC_PRESETS.github.scopes]);
      expect(gh.tokenEndpointAuth).to.eq('client_secret_post');
      expect(one(client({ preset: 'github', tokenEndpointAuth: 'client_secret_basic' })).tokenEndpointAuth).to.eq('client_secret_basic');
    });

    it('reads the redirects', () => {
      expect(read({}, undefined, { redirects: { success: '/app', failure: '/login?failed' } }).redirects).to.deep.eq({ success: '/app', failure: '/login?failed' });
      expect(read({}, undefined, { redirects: { failure: '/login' } }).redirects).to.deep.eq({ success: '/', failure: '/login' });
    });

    it('ignores members set to undefined', () => {
      const p = one(generic({ preset: undefined, scopes: undefined, claims: { email: undefined } }));
      expect(p.preset).to.eq(null);
      expect(p.claims.email).to.eq('email');
    });

    it('keeps several providers by name', () => {
      const options = read({ corp: generic(), google: client({ preset: 'google' }), 'git_hub-2': client({ preset: 'github' }) });
      expect([...options.providers.keys()]).to.deep.eq(['corp', 'google', 'git_hub-2']);
      expect(options.providers.get('git_hub-2')!.strategy).to.eq('oidc:git_hub-2');
    });
  });

  describe('presets', () => {
    it('google resolves to its issuer and alias', () => {
      const p = one(client({ preset: 'google' }));
      expect(p).to.deep.include({ preset: 'google', idToken: true, issuer: 'https://accounts.google.com', endpoints: null, source: { preset: 'google' } });
      expect(p.issuerAliases).to.deep.eq(['accounts.google.com']);
    });

    it('entra resolves the tenant into its v2.0 issuer, lower-cased', () => {
      expect(one(client({ preset: 'entra', tenant: TENANT })).issuer).to.eq(`https://login.microsoftonline.com/${TENANT}/v2.0`);
      expect(one(client({ preset: 'entra', tenant: TENANT.toUpperCase() })).issuer).to.eq(`https://login.microsoftonline.com/${TENANT}/v2.0`);
    });

    it('keycloak resolves {baseUrl}/realms/{realm}, trimming the trailing slash', () => {
      expect(one(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: 'corp' })).issuer).to.eq('https://kc.example.test/realms/corp');
      expect(one(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test/', realm: 'corp' })).issuer).to.eq('https://kc.example.test/realms/corp');
      expect(one(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test/auth//', realm: 'corp' })).issuer).to.eq('https://kc.example.test/auth/realms/corp');
    });

    it('auth0 resolves https://{domain}/', () => {
      expect(one(client({ preset: 'auth0', domain: 'corp.eu.auth0.com' })).issuer).to.eq('https://corp.eu.auth0.com/');
    });

    it("okta resolves the 'default' server, a named one, or the org server", () => {
      expect(one(client({ preset: 'okta', domain: 'corp.okta.com' })).issuer).to.eq('https://corp.okta.com/oauth2/default');
      expect(one(client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: 'aus1a2b3c' })).issuer).to.eq('https://corp.okta.com/oauth2/aus1a2b3c');
      expect(one(client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: null })).issuer).to.eq('https://corp.okta.com');
    });

    it('github resolves its OAuth2 endpoints, for github.com and an Enterprise Server host', () => {
      const gh = one(client({ preset: 'github' }));
      expect(gh).to.deep.include({ preset: 'github', idToken: false, issuer: null, userinfo: true });
      expect(gh.issuerAliases).to.deep.eq([]);
      expect(gh.endpoints).to.deep.eq({ authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user' });
      const ghes = one(client({ preset: 'github', host: 'github.corp.example', userinfo: true }));
      expect(ghes.endpoints).to.deep.eq({ authorization: 'https://github.corp.example/login/oauth/authorize', token: 'https://github.corp.example/login/oauth/access_token', userinfo: 'https://github.corp.example/api/v3/user' });
    });

    it('resolveIssuer and resolveEndpoints fill the placeholders of each preset', () => {
      const cases: [OidcProviderSource, string][] = [
        [{ issuer: ISSUER }, ISSUER],
        [{ preset: 'google' }, 'https://accounts.google.com'],
        [{ preset: 'entra', tenant: TENANT }, `https://login.microsoftonline.com/${TENANT}/v2.0`],
        [{ preset: 'keycloak', baseUrl: 'https://kc.example.test/', realm: 'corp' }, 'https://kc.example.test/realms/corp'],
        [{ preset: 'auth0', domain: 'corp.auth0.com' }, 'https://corp.auth0.com/'],
        [{ preset: 'okta', domain: 'corp.okta.com' }, 'https://corp.okta.com/oauth2/default'],
        [{ preset: 'okta', domain: 'corp.okta.com', authorizationServer: null }, 'https://corp.okta.com'],
      ];
      for (const [source, issuer] of cases) {
        expect(resolveIssuer(source), JSON.stringify(source)).to.eq(issuer);
      }
      expect(() => resolveIssuer({ preset: 'github' })).to.throw();
      expect(resolveEndpoints({ preset: 'github' })).to.deep.eq(OIDC_PRESETS.github.endpoints);
      expect(resolveEndpoints({ preset: 'github', host: 'gh.corp.example' }).userinfo).to.eq('https://gh.corp.example/api/v3/user');
      expect(() => resolveEndpoints({ preset: 'google' })).to.throw();
    });

    it('ships one frozen preset per id, ID token presets with an issuer, github with endpoints', () => {
      expect(Object.keys(OIDC_PRESETS).sort()).to.deep.eq(['auth0', 'entra', 'github', 'google', 'keycloak', 'okta']);
      for (const [id, preset] of Object.entries(OIDC_PRESETS)) {
        expect(preset.id).to.eq(id);
        expect(Object.isFrozen(preset)).to.eq(true);
        expect(Object.isFrozen(preset.claims)).to.eq(true);
        expect(preset.idToken).to.eq(id !== 'github');
      }
      expect(OIDC_PRESETS.github.claims).to.deep.eq({ subject: 'id', email: 'email', emailVerified: null, name: 'name', groups: null });
      expect(OIDC_PRESETS.github.tokenEndpointAuth).to.eq('client_secret_post');
    });
  });

  describe('boot checks (D14)', () => {
    it('refuses a provider name outside 1–59 of [a-z0-9_-]', () => {
      for (const name of ['Corp', 'a'.repeat(60), 'co rp', 'corp.x', 'oidc:corp', '']) {
        refused(() => read({ [name]: generic() }), 'authn.oidc.providers', 'name');
      }
      expect(read({ ['a'.repeat(59)]: generic() }).providers.size).to.eq(1);
    });

    it('refuses an unknown key', () => {
      refusedProvider(generic({ pkce: false }), 'pkce');
      refused(() => readOidcOptions({ providers: {}, flow: 'implicit' }, undefined), 'authn.oidc', 'flow');
    });

    it('refuses a provider without its source', () => {
      refusedProvider(client(), 'issuer');
      refusedProvider(client({ preset: 'gitlab' }), 'preset');
      refusedProvider(client({ preset: 'entra' }), 'tenant');
      refusedProvider(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test' }), 'realm');
      refusedProvider(client({ preset: 'auth0' }), 'domain');
      refusedProvider(client({ preset: 'okta' }), 'domain');
    });

    it('refuses an issuer on a preset, and the parameters of another source', () => {
      refusedProvider(client({ preset: 'google', issuer: 'https://evil.example' }), 'issuer');
      refusedProvider(client({ preset: 'github', issuer: 'https://evil.example' }), 'issuer');
      refusedProvider(generic({ tenant: TENANT }), 'tenant');
      refusedProvider(client({ preset: 'auth0', domain: 'corp.auth0.com', realm: 'x' }), 'realm');
      refusedProvider(client({ preset: 'google', host: 'github.com' }), 'host');
    });

    it('refuses userinfo off for github', () => {
      refusedProvider(client({ preset: 'github', userinfo: false }), 'userinfo');
    });

    it('refuses a client without its id or secret ref', () => {
      refusedProvider(generic({ clientId: undefined }), 'clientId');
      refusedProvider(generic({ clientId: '' }), 'clientId');
      refusedProvider(generic({ clientSecret: undefined }), 'clientSecret');
      refusedProvider(generic({ clientSecret: SECRET }), 'clientSecret');
      refusedProvider(generic({ clientSecret: { secret: '' } }), 'clientSecret.secret');
      refusedProvider(generic({ clientSecret: { secret: null } }), 'clientSecret.secret');
      refusedProvider(generic({ clientSecret: { secret: SECRET, version: 1 } }), 'version');
    });

    it('refuses a token endpoint auth outside the enum', () => {
      refusedProvider(generic({ tokenEndpointAuth: 'none' }), 'tokenEndpointAuth');
      refusedProvider(generic({ tokenEndpointAuth: 'private_key_jwt' }), 'tokenEndpointAuth');
    });

    it('refuses scopes that are not scope tokens', () => {
      refusedProvider(generic({ scopes: 'openid email' }), 'scopes');
      refusedProvider(generic({ scopes: ['openid email'] }), 'scopes');
      refusedProvider(generic({ scopes: [''] }), 'scopes');
      refusedProvider(generic({ scopes: ['openid', 'openid'] }), 'scopes');
    });

    it('refuses a claims mapping outside the shape', () => {
      refusedProvider(generic({ claims: { subject: null } }), 'claims.subject');
      refusedProvider(generic({ claims: { subject: '' } }), 'claims.subject');
      refusedProvider(generic({ claims: { subject: [] } }), 'claims.subject');
      refusedProvider(generic({ claims: { email: 42 } }), 'claims.email');
      refusedProvider(generic({ claims: { roles: 'roles' } }), 'roles');
    });

    it('refuses a subject mapped to email, upn, preferred_username, login or name (nOAuth)', () => {
      for (const subject of ['email', 'upn', 'preferred_username', 'login', 'name', 'Email', 'UPN', ['user', 'Preferred_Username'], ['profile', 'login']]) {
        refusedProvider(generic({ claims: { subject } }), 'claims.subject');
      }
      refusedProvider(client({ preset: 'github', claims: { subject: 'login' } }), 'claims.subject');
      expect(one(generic({ claims: { subject: ['email', 'id'] } })).claims.subject).to.deep.eq(['email', 'id']);
      expect(one(generic({ claims: { subject: 'oid' } })).claims.subject).to.eq('oid');
    });

    it('refuses algorithms outside a non-empty subset of the signing algorithms', () => {
      refusedProvider(generic({ algorithms: [] }), 'algorithms');
      refusedProvider(generic({ algorithms: ['HS256'] }), 'algorithms');
      refusedProvider(generic({ algorithms: ['none'] }), 'algorithms');
      refusedProvider(generic({ algorithms: ['RS256', 'RS256'] }), 'algorithms');
    });

    it('refuses a clock skew outside the integers 0–300', () => {
      for (const clockSkewSeconds of [-1, 301, 1.5, '30']) {
        refusedProvider(generic({ clockSkewSeconds }), 'clockSkewSeconds');
      }
      expect(one(generic({ clockSkewSeconds: 300 })).clockSkewSeconds).to.eq(300);
    });

    it('refuses a userinfo switch that is not a boolean', () => {
      refusedProvider(generic({ userinfo: 'yes' }), 'userinfo');
    });

    it('refuses required claims other than strings, numbers and booleans', () => {
      refusedProvider(generic({ requiredClaims: { groups: ['admin'] } }), 'requiredClaims');
      refusedProvider(generic({ requiredClaims: { tid: null } }), 'requiredClaims');
      refusedProvider(generic({ requiredClaims: { n: Number.NaN } }), 'requiredClaims');
    });

    it('refuses reserved or non-string authorization parameters', () => {
      for (const param of OIDC_RESERVED_PARAMS) {
        refusedProvider(generic({ authorizationParams: { [param]: 'x' } }), param);
      }
      refusedProvider(generic({ authorizationParams: { prompt: 1 } }), 'authorizationParams');
    });

    it('refuses linking switches that are not booleans', () => {
      refusedProvider(generic({ linking: { jit: 'true' } }), 'linking');
      refusedProvider(generic({ linking: { provision: true } }), 'provision');
    });

    it('refuses an Entra tenant that is not a GUID', () => {
      for (const tenant of ['common', 'organizations', 'consumers', 'contoso.com', `${TENANT}x`, TENANT.replace(/-/g, '')]) {
        refusedProvider(client({ preset: 'entra', tenant }), 'tenant');
      }
    });

    it('refuses an issuer that is not an https URL, unless the env is development or test', () => {
      for (const issuer of ['http://idp.example.test', 'idp.example.test', '/realms/corp', 'ftp://idp.example.test', 'https://idp.example.test/?x=1', 'https://idp.example.test/#x', 'https://user:pw@idp.example.test', ' https://idp.example.test', 'https://idp.example.test\\realms']) {
        refusedProvider(generic({ issuer }), 'issuer');
      }
      expect(one(generic({ issuer: 'http://localhost:8080/realms/corp' }), 'test').issuer).to.eq('http://localhost:8080/realms/corp');
      expect(one(generic({ issuer: 'http://localhost:8080/realms/corp' }), 'development').issuer).to.eq('http://localhost:8080/realms/corp');
      expect(one(generic({ issuer: 'http://localhost:8080/realms/corp' }), 'dev').issuer).to.eq('http://localhost:8080/realms/corp');
      refusedProvider(generic({ issuer: 'http://localhost:8080/realms/corp' }), 'issuer', 'production');
      refusedProvider(generic({ issuer: 'http://localhost:8080/realms/corp' }), 'issuer', 'staging');
      refusedProvider(generic({ issuer: 'ftp://localhost/realms/corp' }), 'issuer', 'test');
    });

    it('refuses a keycloak baseUrl that is not an https URL, unless the env is development or test, and a bad realm', () => {
      refusedProvider(client({ preset: 'keycloak', baseUrl: 'http://kc.example.test', realm: 'corp' }), 'baseUrl');
      refusedProvider(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test?x=1', realm: 'corp' }), 'baseUrl');
      refusedProvider(client({ preset: 'keycloak', baseUrl: 'kc.example.test', realm: 'corp' }), 'baseUrl');
      expect(one(client({ preset: 'keycloak', baseUrl: 'http://localhost:8080', realm: 'corp' }), 'test').issuer).to.eq('http://localhost:8080/realms/corp');
      for (const realm of ['', 'a/b', '..', '.', 'a?b', 'a b']) {
        refusedProvider(client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm }), 'realm');
      }
    });

    it('refuses a domain or host that is not a plain host name', () => {
      for (const domain of ['https://corp.auth0.com', 'corp.auth0.com/path', 'user@corp.auth0.com', 'corp..auth0.com', '-corp.auth0.com', 'corp auth0.com', '']) {
        refusedProvider(client({ preset: 'auth0', domain }), 'domain');
        refusedProvider(client({ preset: 'okta', domain }), 'domain');
        refusedProvider(client({ preset: 'github', host: domain }), 'host');
      }
      for (const authorizationServer of ['', 'a/b', '..']) {
        refusedProvider(client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer }), 'authorizationServer');
      }
      expect(one(client({ preset: 'auth0', domain: 'login.corp.example:8443' })).issuer).to.eq('https://login.corp.example:8443/');
    });

    it('refuses a redirectUri that is not an absolute https URL, unless the env is development or test', () => {
      for (const redirectUri of ['/auth/oidc/corp/callback', 'http://app.example.test/cb', 'https://app.example.test/cb#x', 'javascript:alert(1)', '']) {
        refusedProvider(generic({ redirectUri }), 'redirectUri');
      }
      expect(one(generic({ redirectUri: 'http://localhost:3000/auth/oidc/corp/callback' }), 'test').redirectUri).to.eq('http://localhost:3000/auth/oidc/corp/callback');
      expect(one(generic({ redirectUri: 'https://app.example.test/cb?tenant=a' })).redirectUri).to.eq('https://app.example.test/cb?tenant=a');
    });

    it('refuses redirects that are not app-relative paths', () => {
      for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'login', '', 42]) {
        refused(() => read({}, undefined, { redirects: { success: path } }), 'authn.oidc.redirects.success');
        refused(() => read({}, undefined, { redirects: { failure: path } }), 'authn.oidc.redirects.failure');
      }
      refused(() => read({}, undefined, { redirects: { home: '/' } }), 'home');
    });

    it('warns when a provider linking switch is on while the global one is off', () => {
      const warnings: string[] = [];
      const log = { warn: (m: string) => warnings.push(m) };
      readOidcOptions({ providers: { corp: generic({ linking: { jit: true, byVerifiedEmail: true } }) } }, undefined, { linking: { jit: false, byVerifiedEmail: false }, log });
      expect(warnings).to.have.length(2);
      expect(warnings[0]).to.contain('authn.oidc.providers.corp.linking.jit').and.contain('authn.linking.jit');
      expect(warnings[1]).to.contain('authn.oidc.providers.corp.linking.byVerifiedEmail').and.contain('authn.linking.byVerifiedEmail');

      warnings.length = 0;
      readOidcOptions({ providers: { corp: generic({ linking: { jit: true, byVerifiedEmail: true } }) } }, undefined, { linking: { jit: true, byVerifiedEmail: true }, log });
      readOidcOptions({ providers: { corp: generic({ linking: { jit: false } }) } }, undefined, { linking: { jit: false, byVerifiedEmail: false }, log });
      expect(warnings).to.deep.eq([]);
    });

    it('refuses a config that is not an object', () => {
      refused(() => readOidcOptions('oidc', undefined), 'authn.oidc');
      refused(() => readOidcOptions({ providers: [] }, undefined), 'authn.oidc.providers');
      refused(() => readOidcOptions({ providers: { corp: 'x' } }, undefined), 'corp');
    });
  });

  describe('schemas', () => {
    it('the configuration schema accepts a valid authn.oidc and refuses an invalid one', () => {
      const validate = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(AUTHN_OIDC_CONFIGURATION_SCHEMA);
      expect(validate({ providers: { corp: generic(), gh: client({ preset: 'github' }) }, redirects: { success: '/app' } })).to.eq(true);
      expect(validate({ providers: { Corp: generic() } })).to.eq(false);
      expect(validate({ providers: { corp: generic({ pkce: false }) } })).to.eq(false);
      expect(validate({ providers: {}, redirects: { success: '//evil.example' } })).to.eq(false);
    });

    it('the provider schema is built from the preset ids and the signing algorithms', () => {
      const text = JSON.stringify(AUTHN_OIDC_PROVIDER_SCHEMA);
      for (const id of ['google', 'entra', 'keycloak', 'auth0', 'okta', 'github', ...OIDC_SIGNING_ALGORITHMS]) {
        expect(text).to.contain(`"${id}"`);
      }
      const validate = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(AUTHN_OIDC_PROVIDER_SCHEMA);
      expect(validate(generic())).to.eq(true);
      expect(validate(client({ preset: 'entra', tenant: TENANT }))).to.eq(true);
      expect(validate(client({ preset: 'google', issuer: ISSUER }))).to.eq(false);
    });

    it('lists every reserved authorization parameter once', () => {
      expect([...OIDC_RESERVED_PARAMS].sort()).to.deep.eq(['acr_values', 'client_id', 'code_challenge', 'code_challenge_method', 'max_age', 'nonce', 'redirect_uri', 'request', 'request_uri', 'response_mode', 'response_type', 'scope', 'state']);
      expect(Object.isFrozen(OIDC_RESERVED_PARAMS)).to.eq(true);
    });
  });
});
