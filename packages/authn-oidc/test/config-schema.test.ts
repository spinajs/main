import 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import { OidcBootstrapper } from '../src/bootstrap.js';
import { OIDC_SIGNING_ALGORITHMS } from '../src/contracts.js';
import { buildOidcOptions } from '../src/options/options.js';
import { AUTHN_OIDC_CONFIGURATION_SCHEMA, OIDC_RESERVED_PARAMS } from '../src/options/schema.js';
import { OidcProviders } from '../src/providers.js';
import { boot, configurationOf, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';
import { withSchemaDefaults } from './support/oidc-config.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_OIDC_CONFIGURATION_SCHEMA];
const SECRET = 'SUPER-SECRET-VALUE-42';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const ISSUER = 'https://idp.example.test/realms/corp';

const client = (over: Record<string, unknown> = {}) => ({ clientId: 'canvas', clientSecret: { secret: SECRET }, ...over });
const generic = (over: Record<string, unknown> = {}) => client({ issuer: ISSUER, ...over });
const oidc = (providers: Record<string, unknown>, redirects?: Record<string, unknown>) => ({ authn: { oidc: { providers, ...(redirects ? { redirects } : {}) } } });
const bad = (providers: Record<string, unknown>, redirects?: Record<string, unknown>) => violationsOf(SCHEMAS, oidc(providers, redirects));
const at = (name: string, key: string) => `authn.oidc.providers.${name}.${key}`;

describe('authn.oidc through its own schema', function () {
  // Some cases boot dozens of Configurations.
  this.timeout(30000);
  afterEach(disposeBooted);

  it('compiles under the app validator without strict-mode warnings', () => {
    const require = createRequire(import.meta.url);
    const warnings: string[] = [];
    const Ajv = require('ajv');
    const ajv = new (Ajv.default ?? Ajv)({
      logger: { log: () => undefined, warn: (...m: unknown[]) => warnings.push(m.join(' ')), error: (...m: unknown[]) => warnings.push(m.join(' ')) },
      allErrors: true,
      removeAdditional: true,
      useDefaults: true,
      coerceTypes: true,
      $data: true,
    });
    require('ajv-merge-patch')(ajv);
    require('ajv-formats').default(ajv);
    require('ajv-keywords').default(ajv);
    ajv.addKeyword('$configurationModule');
    ajv.compile(AUTHN_OIDC_CONFIGURATION_SCHEMA);
    expect(warnings, JSON.stringify(warnings)).to.deep.eq([]);
  });

  describe('defaults', () => {
    it('gives an unconfigured authn.oidc no providers and the default redirects', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.oidc')).to.deep.eq({ providers: {}, redirects: { success: '/', failure: '/' } });
    });

    it('fills every default of a provider, equal to the fixture the build tests use', async () => {
      const raw = { providers: { corp: generic() }, redirects: { success: '/app' } };
      const { configuration } = await boot(SCHEMAS, { authn: { oidc: raw } });
      expect(configuration.get('authn.oidc')).to.deep.eq(withSchemaDefaults(raw));
      expect(configuration.get('authn.oidc.providers.corp.algorithms')).to.deep.eq([...OIDC_SIGNING_ALGORITHMS]);
      expect(configuration.get('authn.oidc.providers.corp.clockSkewSeconds')).to.eq(30);
      expect(configuration.get('authn.oidc.redirects.failure')).to.eq('/');
    });

    it('fills the global linking switches', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.linking')).to.deep.eq({ jit: false, byVerifiedEmail: false });
    });

    it('keeps required claim values as configured, with no coercion between string, number and boolean', async () => {
      const requiredClaims = { hd: 'example.com', tier: 2, staff: true, guest: false, level: 0 };
      const { configuration } = await boot(SCHEMAS, oidc({ corp: generic({ requiredClaims }) }));
      expect(configuration.get('authn.oidc.providers.corp.requiredClaims')).to.deep.eq(requiredClaims);
    });
  });

  describe('violations', () => {
    it('names the provider, its name and its shape', async () => {
      expect(await bad({ 'Corp IdP': generic() })).to.include('authn.oidc.providers.Corp IdP');
      expect(await bad({ ['a'.repeat(60)]: generic() })).to.include(`authn.oidc.providers.${'a'.repeat(60)}`);
      expect(await bad({ corp: 'https://idp.example.test' })).to.include('authn.oidc.providers.corp');
      expect(await bad({ corp: { issuer: ISSUER, clientSecret: { secret: SECRET } } })).to.include(at('corp', 'clientId'));
      expect(await bad({ corp: { issuer: ISSUER, clientId: 'c' } })).to.include(at('corp', 'clientSecret'));
      expect(await bad({ corp: generic({ clientSecret: { secret: '' } }) })).to.include(at('corp', 'clientSecret.secret'));
      expect(await bad({ corp: generic({ clientSecret: { secret: null } }) })).to.include(at('corp', 'clientSecret.secret'));
      expect(await bad({ corp: generic({ clientSecret: SECRET }) })).to.include(at('corp', 'clientSecret'));
      expect(await bad({ corp: generic({ clientSecret: { secret: SECRET, other: 1 } }) })).to.include(at('corp', 'clientSecret.other'));
      expect(await bad({ corp: generic({ flow: 'implicit' }) })).to.include(at('corp', 'flow'));
    });

    it('names the key an unknown authn.oidc member or redirect would be', async () => {
      expect(await violationsOf(SCHEMAS, { authn: { oidc: { providers: {}, flow: 'implicit' } } })).to.include('authn.oidc.flow');
      expect(await bad({}, { other: '/x' })).to.include('authn.oidc.redirects.other');
    });

    it('names the source key a preset refuses or lacks', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [client({}), at('corp', 'issuer')],
        [client({ preset: 'myidp', issuer: ISSUER }), at('corp', 'preset')],
        [client({ preset: 'google', issuer: ISSUER }), at('corp', 'issuer')],
        [client({ preset: 'entra' }), at('corp', 'tenant')],
        [client({ preset: 'entra', tenant: 'common' }), at('corp', 'tenant')],
        [client({ preset: 'keycloak', baseUrl: 'https://kc.example.test' }), at('corp', 'realm')],
        [client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: '..' }), at('corp', 'realm')],
        [client({ preset: 'auth0', domain: 'https://corp.auth0.com' }), at('corp', 'domain')],
        [client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: '../x' }), at('corp', 'authorizationServer')],
        [client({ preset: 'github', userinfo: false }), at('corp', 'userinfo')],
        [client({ preset: 'github', issuer: ISSUER }), at('corp', 'issuer')],
        [generic({ tenant: TENANT }), at('corp', 'tenant')],
        [client({ preset: 'auth0', domain: 'corp.auth0.com', realm: 'x' }), at('corp', 'realm')],
        [client({ preset: 'google', host: 'github.com' }), at('corp', 'host')],
      ];
      for (const [provider, path] of cases) expect(await bad({ corp: provider }), JSON.stringify(provider)).to.include(path);
    });

    it('accepts one sound config per preset', async () => {
      const sound = [
        client({ preset: 'google' }),
        client({ preset: 'entra', tenant: TENANT }),
        client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm: 'corp' }),
        client({ preset: 'auth0', domain: 'corp.auth0.com' }),
        client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer: null }),
        client({ preset: 'github', host: 'ghe.example.test', userinfo: true }),
        generic(),
      ];
      for (const provider of sound) expect(await bad({ corp: provider }), JSON.stringify(provider)).to.deep.eq([]);
    });

    it('names the bad option', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ tokenEndpointAuth: 'none' }, 'tokenEndpointAuth'],
        [{ tokenEndpointAuth: 'private_key_jwt' }, 'tokenEndpointAuth'],
        [{ scopes: 'openid email' }, 'scopes'],
        [{ scopes: ['openid', 'openid'] }, 'scopes'],
        [{ scopes: ['bad scope'] }, 'scopes.0'],
        [{ algorithms: ['HS256'] }, 'algorithms.0'],
        [{ algorithms: ['none'] }, 'algorithms.0'],
        [{ algorithms: [] }, 'algorithms'],
        [{ clockSkewSeconds: 301 }, 'clockSkewSeconds'],
        [{ clockSkewSeconds: -1 }, 'clockSkewSeconds'],
        [{ clockSkewSeconds: 1.5 }, 'clockSkewSeconds'],
        [{ userinfo: 'yes' }, 'userinfo'],
        [{ requiredClaims: { tier: {} } }, 'requiredClaims.tier'],
        [{ requiredClaims: { groups: ['admin'] } }, 'requiredClaims.groups'],
        [{ requiredClaims: { tid: null } }, 'requiredClaims.tid'],
        [{ authorizationParams: { state: 'x' } }, 'authorizationParams.state'],
        [{ authorizationParams: { ui_locales: {} } }, 'authorizationParams.ui_locales'],
        [{ claims: { typo: 'x' } }, 'claims.typo'],
        [{ claims: { subject: '' } }, 'claims.subject'],
        [{ claims: { subject: null } }, 'claims.subject'],
        [{ claims: { subject: [] } }, 'claims.subject'],
        [{ linking: { typo: true } }, 'linking.typo'],
        [{ linking: { jit: 'yes' } }, 'linking.jit'],
        [{ redirectUri: '' }, 'redirectUri'],
      ];
      for (const [over, key] of cases) expect(await bad({ corp: generic(over) }), JSON.stringify(over)).to.include(at('corp', key));
    });

    it('names every reserved authorization parameter', async () => {
      for (const param of OIDC_RESERVED_PARAMS) {
        expect(await bad({ corp: generic({ authorizationParams: { [param]: 'x' } }) }), param).to.include(at('corp', `authorizationParams.${param}`));
      }
    });

    it('names an Entra tenant that is not a GUID, and a realm or authorization server that is not one segment', async () => {
      for (const tenant of ['common', 'organizations', 'consumers', 'contoso.com', `${TENANT}x`, TENANT.replace(/-/g, '')]) {
        expect(await bad({ corp: client({ preset: 'entra', tenant }) }), tenant).to.include(at('corp', 'tenant'));
      }
      for (const realm of ['', 'a/b', '..', '.', 'a?b', 'a b']) {
        expect(await bad({ corp: client({ preset: 'keycloak', baseUrl: 'https://kc.example.test', realm }) }), realm).to.include(at('corp', 'realm'));
      }
      for (const authorizationServer of ['', 'a/b', '..']) {
        expect(await bad({ corp: client({ preset: 'okta', domain: 'corp.okta.com', authorizationServer }) }), authorizationServer).to.include(at('corp', 'authorizationServer'));
      }
    });

    it('names a domain or host that is not a plain host name with a port in 1-65535', async () => {
      const notHosts = ['https://corp.auth0.com', 'corp.auth0.com/path', 'user@corp.auth0.com', 'corp..auth0.com', '-corp.auth0.com', 'corp auth0.com', ''];
      for (const domain of [...notHosts, 'corp.auth0.com:0', 'corp.auth0.com:65536', 'corp.auth0.com:99999', 'corp.auth0.com:080']) {
        expect(await bad({ corp: client({ preset: 'auth0', domain }) }), domain).to.include(at('corp', 'domain'));
        expect(await bad({ corp: client({ preset: 'okta', domain }) }), domain).to.include(at('corp', 'domain'));
        expect(await bad({ corp: client({ preset: 'github', host: domain }) }), domain).to.include(at('corp', 'host'));
      }
      expect(await bad({ corp: client({ preset: 'auth0', domain: 'corp.auth0.com:65535' }) })).to.deep.eq([]);
    });

    it('names a redirect that is not an app-relative path', async () => {
      const notPaths = ['//evil.example.com', '/\\evil.example.com', 'https://evil.example.com', '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/ /evil.example', '/a\\b', '/a\u007f', '/a\u0000', 'relative', '', 42, null];
      for (const value of notPaths) {
        expect(await bad({}, { success: value }), JSON.stringify(value)).to.include('authn.oidc.redirects.success');
        expect(await bad({}, { failure: value }), JSON.stringify(value)).to.include('authn.oidc.redirects.failure');
      }
      expect(await bad({}, { success: '/app?x=1&y=%20', failure: '/' })).to.deep.eq([]);
    });

    it('never puts a configured value into the error', async () => {
      let error: unknown;
      try {
        await boot(SCHEMAS, oidc({ corp: generic({ clockSkewSeconds: 999 }) }));
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidConfiguration);
      expect((error as Error).message).to.not.contain(SECRET);
      expect(JSON.stringify((error as InvalidConfiguration).violations)).to.not.contain(SECRET);
    });
  });

  describe('what buildOidcOptions still checks', () => {
    const configOf = async (providers: Record<string, unknown>) => (await boot(SCHEMAS, oidc(providers))).configuration.get<never>('authn.oidc');

    it('refuses http endpoints outside development and test, naming the key', async () => {
      const cfg = await configOf({ corp: generic({ issuer: 'http://idp.example.test/realms/corp' }) });
      for (const env of ['production', 'staging', undefined]) {
        expect(() => buildOidcOptions(cfg, env), String(env)).to.throw(InvalidOption, 'authn.oidc.providers.corp.issuer');
      }
      for (const env of ['development', 'test']) expect(buildOidcOptions(cfg, env).providers.get('corp')!.issuer).to.eq('http://idp.example.test/realms/corp');
    });

    it('refuses a redirectUri with a fragment', async () => {
      const cfg = await configOf({ corp: generic({ redirectUri: 'https://app.example.test/cb#x' }) });
      expect(() => buildOidcOptions(cfg, 'production')).to.throw(InvalidOption, 'authn.oidc.providers.corp.redirectUri');
    });

    it('refuses a mutable subject claim, preset or not', async () => {
      for (const subject of ['email', 'upn', ['profile', 'preferred_username']]) {
        const cfg = await configOf({ corp: generic({ claims: { subject } }) });
        expect(() => buildOidcOptions(cfg, 'production'), JSON.stringify(subject)).to.throw(InvalidOption, 'immutable subject');
      }
    });

    it('warns when a provider switch has no global switch behind it, and redacts the secret', async () => {
      const cfg = await configOf({ corp: generic({ linking: { jit: true } }) });
      const warnings: string[] = [];
      const options = buildOidcOptions(cfg, 'production', { linking: { jit: false, byVerifiedEmail: false }, log: { warn: (m) => warnings.push(m) } });
      expect(warnings.join('\n')).to.contain('authn.oidc.providers.corp.linking.jit').and.to.contain('authn.linking.jit');
      const provider = options.providers.get('corp')!;
      expect(provider.clientSecret.secret).to.eq(SECRET);
      expect(JSON.stringify(provider)).to.not.contain(SECRET);
      expect(Object.isFrozen(provider)).to.eq(true);
    });
  });

  // An authn.oidc the schema never saw: the package's controller is found by a directory scan, so it can run in an
  // app that never imported the package root and so never registered the schema.
  describe('values that never went through the schema', () => {
    const unchecked = (provider: Record<string, unknown>, redirects: Record<string, unknown> = {}) =>
      ({ providers: { corp: { ...withSchemaDefaults({ providers: { corp: generic() } }).providers.corp, ...provider } }, redirects: { success: '/', failure: '/', ...redirects } }) as never;

    it('refuses a redirect that is not an app-relative path', () => {
      for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', '/\t/evil.example', undefined, 42]) {
        expect(() => buildOidcOptions(unchecked({}, { success: value }), 'production'), JSON.stringify(value)).to.throw(InvalidOption, 'authn.oidc.redirects.success');
        expect(() => buildOidcOptions(unchecked({}, { failure: value }), 'production'), JSON.stringify(value)).to.throw(InvalidOption, 'authn.oidc.redirects.failure');
      }
    });

    it('refuses a clock skew that would switch the exp, iat and nbf checks off', () => {
      for (const clockSkewSeconds of [undefined, Number.NaN, '30', 1e9, -1, 1.5]) {
        expect(() => buildOidcOptions(unchecked({ clockSkewSeconds }), 'production'), String(clockSkewSeconds)).to.throw(InvalidOption, 'authn.oidc.providers.corp.clockSkewSeconds');
      }
    });

    it('turns a provider linking switch on only for true', () => {
      const p = buildOidcOptions(unchecked({ linking: { jit: 'false', byVerifiedEmail: 1 } }), 'production').providers.get('corp')!;
      expect(p.linking).to.deep.eq({ jit: false, byVerifiedEmail: false });
      expect(buildOidcOptions(unchecked({ linking: undefined }), 'production').providers.get('corp')!.linking).to.deep.eq({ jit: false, byVerifiedEmail: false });
    });

    it('turns a global linking switch on only for true', async () => {
      for (const linking of [{ jit: 'yes', byVerifiedEmail: 1 }, undefined]) {
        const values: Record<string, unknown> = { 'authn.oidc': { providers: {}, redirects: { success: '/', failure: '/' } }, 'authn.linking': linking };
        const configuration = { get: (path: string) => values[path] };
        const container = { Registry: { ownsRegistration: () => true }, getRegisteredTypes: () => [], get: () => configuration, resolve: async () => configuration } as unknown as IContainer;
        const providers = readingFrom(new OidcProviders(container), container);
        await providers.resolve();
        expect(providers.linking, JSON.stringify(linking)).to.deep.eq({ jit: false, byVerifiedEmail: false });
      }
    });
  });

  describe('OidcBootstrapper', () => {
    const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
    const Spec = configurationOf({ authn: { oidc: { providers: {} } } });
    let saved: unknown[] = [];

    before(() => {
      saved = [...schemas()];
      DI.register(Spec).as(Configuration);
    });

    after(() => {
      DI.unregister(Spec);
      DI.uncache(Configuration);
      DI.uncache('__configurationSchema__' as never);
      for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
    });

    it('registers the authn.oidc schema before the Configuration boots', async () => {
      await new OidcBootstrapper().bootstrap();
      expect(schemas()).to.include(AUTHN_OIDC_CONFIGURATION_SCHEMA);
    });
  });
});
