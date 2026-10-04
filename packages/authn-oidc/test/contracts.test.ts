import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ExternalLoginHook } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef } from '@spinajs/authn/contracts';

import { OIDC_PRESET_IDS, OIDC_SIGNING_ALGORITHMS } from '../src/contracts.js';
import type { OidcAppPath, OidcAuthorizationParams, OidcClaimPath, OidcClaimsMapping, OidcClientConfig, OidcConfig, OidcEndpoints, OidcEntraTenantId, OidcExternalSubject, OidcMappedClaims, OidcPreset, OidcPresetId, OidcProviderConfig, OidcProviderSource, OidcReservedParam, OidcSecretRef, OidcSigningAlgorithm, OidcStrategyName, OidcTokenEndpointAuth } from '../src/contracts.js';
import * as contracts from '../src/contracts.js';
import * as index from '../src/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;
type KeysOf<T> = T extends unknown ? keyof T : never;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FILE = join(PKG_ROOT, 'src', 'contracts.ts');

const PRESETS = ['google', 'entra', 'keycloak', 'auth0', 'okta', 'github'] as const;
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] as const;
const RESERVED = ['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'request', 'request_uri', 'max_age', 'acr_values'] as const;
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const INDEX_VALUES = [
  'AUTHN_OIDC_CONFIGURATION_SCHEMA', 'AUTHN_OIDC_PROVIDER_SCHEMA', 'CoreOidcAccountLinks', 'DEFAULT_CLAIMS', 'DISCOVERY_MAX_AGE_MS', 'DISCOVERY_RETRY_MS',
  'FetchOidcHttpClient', 'JWKS_MAX_AGE_MS', 'JWKS_REFRESH_MS', 'MAX_EMAIL_LENGTH', 'MAX_SUBJECT_LENGTH', 'OIDC_APP_PATH_PATTERN', 'OIDC_ENTRA_TENANT_PATTERN',
  'OIDC_FAILURE_BODY', 'OIDC_FLOW_COOKIE_BASE_NAME', 'OIDC_FLOW_COOKIE_MAX_LENGTH', 'OIDC_FLOW_FUTURE_SKEW_SECONDS', 'OIDC_FLOW_TTL_SECONDS', 'OIDC_HOST_PATTERN',
  'OIDC_HTTP_MAX_BODY_BYTES', 'OIDC_HTTP_TIMEOUT_MS', 'OIDC_PRESETS', 'OIDC_PRESET_IDS', 'OIDC_PROVIDER_NAME_PATTERN', 'OIDC_RESERVED_PARAMS', 'OIDC_SEGMENT_PATTERN',
  'OIDC_SIGNING_ALGORITHMS', 'OidcAccountLinks', 'OidcBootstrapper', 'OidcDiscovery', 'OidcHttpClient', 'OidcJwks', 'OidcLogin', 'OidcProvider', 'OidcProviders',
  'OidcStrategy', 'appEnvOf', 'appPathOrNull', 'atHashOf', 'authorizationUrl', 'clearFlowCookie', 'codeChallengeOf', 'decodeFlow', 'discoveryUrlOf', 'encodeFlow',
  'exchangeCode', 'fetchUserinfo', 'flowCookie', 'flowCookieName', 'flowIsLive', 'flowSecrets', 'hasRequiredClaims', 'mapClaims', 'newFlow', 'providerNamesOf',
  'rawClaims', 'readClaim', 'readOidcOptions', 'registerOidcStrategies', 'requestOrigin', 'resolveEndpoints', 'resolveIssuer', 'sessionBindingOf', 'sha256hex',
  'stateClaim', 'trustedPeer', 'validateIdToken',
].sort();

const secret: OidcSecretRef = { secret: 'env://OIDC_CORP_SECRET' };

const sf = ts.createSourceFile(SRC_FILE, readFileSync(SRC_FILE, 'utf8'), ts.ScriptTarget.Latest, true);
// Line breaks inside a doc comment become single spaces, so a phrase may wrap.
const docText = (n: ts.Node) =>
  ts
    .getJSDocCommentsAndTags(n)
    .map((d) => d.getText(sf).replace(/[ \t]*\r?\n[ \t]*\*(?!\/)[ \t]*/g, ' '))
    .join(' ');
const declarationDocs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  sf.forEachChild((n) => {
    if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) out[n.name.text] = docText(n);
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) out[d.name.getText(sf)] = docText(n);
  });
  return out;
};
// Docs of every property of a declaration, nested ones included, joined per name.
const memberDocs = (name: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if (ts.isPropertySignature(node)) out[node.name.getText(sf)] = [out[node.name.getText(sf)], docText(node)].filter(Boolean).join(' ');
    node.forEachChild(visit);
  };
  sf.forEachChild((n) => {
    if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name.text === name) visit(n);
  });
  return out;
};

class GroupSync extends ExternalLoginHook {
  readonly seen: [IdentityRef, readonly string[] | undefined][] = [];
  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    this.seen.push([identity, (external as OidcExternalSubject).claims.groups]);
  }
}

describe('authn-oidc contracts', () => {
  describe('runtime', () => {
    it('the contracts export only the preset ids and the signing algorithms as values, and the index re-exports them', () => {
      expect(Object.keys(contracts).sort()).to.deep.eq(['OIDC_PRESET_IDS', 'OIDC_SIGNING_ALGORITHMS']);
      expect(index.OIDC_PRESET_IDS).to.eq(OIDC_PRESET_IDS);
      // The package's runtime surface, pinned so an export cannot appear unnoticed.
      expect(Object.keys(index).sort()).to.deep.eq(INDEX_VALUES);
      expect(index.OIDC_SIGNING_ALGORITHMS).to.eq(OIDC_SIGNING_ALGORITHMS);
    });

    it('lists every preset id once, frozen', () => {
      expect(OIDC_PRESET_IDS).to.deep.eq([...PRESETS]);
      expect(Object.isFrozen(OIDC_PRESET_IDS)).to.eq(true);
    });

    it('lists only asymmetric signing algorithms, frozen', () => {
      expect(OIDC_SIGNING_ALGORITHMS).to.deep.eq([...ALGORITHMS]);
      expect(Object.isFrozen(OIDC_SIGNING_ALGORITHMS)).to.eq(true);
      for (const alg of OIDC_SIGNING_ALGORITHMS) {
        expect(alg.toLowerCase()).to.not.eq('none');
        expect(alg).to.not.match(/^HS/i);
      }
    });

    it('mapped claims, groups included, reach an ExternalLoginHook', async () => {
      const external: OidcExternalSubject = { provider: 'oidc:corp', subject: 's-1', email: 'a@b.c', emailVerified: true, claims: { name: 'A', groups: ['eng'], raw: { sub: 's-1', groups: ['eng'] } } };
      const hook = new GroupSync();
      await hook.afterLogin({ type: 'user', id: 'alice' }, external);
      expect(hook.seen).to.deep.eq([[{ type: 'user', id: 'alice' }, ['eng']]]);
    });
  });

  describe('boundary', () => {
    it('contracts.ts imports only @spinajs/authn/contracts', () => {
      const info = ts.preProcessFile(readFileSync(SRC_FILE, 'utf8'), true, true);
      expect(info.importedFiles.map((f) => f.fileName)).to.deep.eq(['@spinajs/authn/contracts']);
    });

    it('the package lists no authz or users package (H29)', () => {
      const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
      const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
      expect(deps).to.include('@spinajs/authn');
      expect(deps.filter((d) => /^@spinajs\/(authz|users|rbac)/.test(d))).to.deep.eq([]);
    });
  });

  describe('docs', () => {
    it('the provider config states the fixed behaviour', () => {
      const d = declarationDocs().OidcProviderConfig;
      for (const phrase of ['authn.oidc.providers.<name>', 'authorization code flow only', 'no implicit or hybrid flow', 'PKCE S256', 'state and nonce single use', 'bound to the browser', 'and to this provider', 'mix-up', 'RFC 9207', 'every provider endpoint (discovery, JWKS, authorization, token, userinfo) over https', 'iss exact', 'issuerAliases', 'aud', 'azp', 'exp', 'iat', 'nbf when present', 'nonce', 'algorithms', 'at_hash when present', 'userinfo sub', 'A02']) {
        expect(d, phrase).to.contain(phrase);
      }
    });

    it('members carry the rules a reader needs', () => {
      const docs = declarationDocs();
      expect(docs.OidcSigningAlgorithm).to.contain("never 'none'");
      expect(docs.OidcSigningAlgorithm).to.contain('HMAC');
      expect(docs.OIDC_PRESET_IDS).to.contain('schema');
      expect(docs.OidcConfig).to.contain('authn.oidc');
      expect(docs.OidcSecretRef).to.contain('authn.local.pepper');
      expect(docs.OidcSecretRef).to.contain('never logged or returned');
      expect(docs.OidcStrategyName).to.contain('ExternalSubject.provider');

      const client = memberDocs('OidcClientConfig');
      expect(client.clientSecret).to.contain('confidential clients only');
      expect(client.clientSecret).to.contain('later RFC');
      expect(client.algorithms).to.contain('OIDC_SIGNING_ALGORITHMS');
      expect(client.clockSkewSeconds).to.contain('30');
      expect(client.redirectUri).to.contain('exactly');
      expect(client.redirectUri).to.contain('authn.http.trustProxy');
      expect(client.redirectUri).to.contain("the provider's exact match is the guard");
      expect(client.jit).to.contain('IdentityStore.provision');
      expect(client.jit).to.contain('authn.linking.jit');
      expect(client.jit).to.contain('Default false');
      expect(client.byVerifiedEmail).to.contain('authn.linking.byVerifiedEmail');
      expect(client.byVerifiedEmail).to.contain('verified');
      expect(client.byVerifiedEmail).to.contain('Default false');
      expect(client.linking).to.contain('never opens sign-up');
      expect(client.authorizationParams).to.contain('reserved');
      expect(client.requiredClaims).to.contain('A02');
      expect(docs.OidcReservedParam).to.contain("flow's own parameters");
      expect(docs.OidcReservedParam).to.contain('max_age');
      expect(docs.OidcAppPath).to.contain('app-relative');

      const claims = memberDocs('OidcClaimsMapping');
      expect(claims.subject).to.contain("Default 'sub'");
      expect(claims.subject).to.contain('immutable');
      expect(claims.subject).to.contain('never an email, upn, preferred_username, login or name');
      expect(claims.subject).to.contain('refuses at boot');
      expect(claims.subject).to.contain('unlinks');
      expect(claims.emailVerified).to.contain('Only a boolean true');
      expect(claims.groups).to.contain('leave memberships alone');

      const source = memberDocs('OidcProviderSource');
      expect(source.issuer).to.contain('discovery');
      expect(source.issuer).to.contain('new name');
      expect(source.tenant).to.contain('by id');
      expect(source.tenant).to.contain("'common'");
      expect(source.authorizationServer).to.contain('null: the org authorization server');
      expect(source.host).to.contain('GitHub Enterprise Server');
      expect(source.userinfo).to.contain('cannot be turned off');

      expect(memberDocs('OidcMappedClaims').groups).to.contain('Absent');
      expect(memberDocs('OidcMappedClaims').raw).to.contain('never a token');
      const oidc = memberDocs('OidcConfig');
      expect(oidc.providers).to.contain('1–59');
      expect(oidc.providers).to.contain("provider 'oidc:<name>'");
      expect(oidc.providers).to.contain('unlinks');
      expect(oidc.redirects).to.contain('no reason (A02)');
      expect(oidc.redirects).to.contain('returnTo');
      expect(oidc.redirects).to.contain('app-relative path, kept with the state');
      expect(oidc.redirects).to.contain('no open redirect');
      expect(memberDocs('OidcPreset').issuerAliases).to.contain('accounts.google.com');
    });
  });

  describe('types', () => {
    it('the index re-exports every type', () => {
      same<index.OidcProviderConfig, OidcProviderConfig>(true);
      same<index.OidcPreset, OidcPreset>(true);
      same<index.OidcClaimsMapping, OidcClaimsMapping>(true);
      same<index.OidcPresetId, OidcPresetId>(true);
      same<index.OidcSigningAlgorithm, OidcSigningAlgorithm>(true);
      same<index.OidcConfig, OidcConfig>(true);
      same<index.OidcExternalSubject, OidcExternalSubject>(true);
    });

    it('the preset ids are a closed union', () => {
      same<OidcPresetId, (typeof PRESETS)[number]>(true);
      same<typeof OIDC_PRESET_IDS, readonly OidcPresetId[]>(true);
      // @ts-expect-error no such preset
      const gitlab: OidcPresetId = 'gitlab';
      // @ts-expect-error closed: not an open string union
      const any: OidcPresetId = 'x' as string;
      expect([gitlab, any]).to.have.length(2);
    });

    it('the algorithm allow-list excludes none and HMAC', () => {
      same<OidcSigningAlgorithm, (typeof ALGORITHMS)[number]>(true);
      same<typeof OIDC_SIGNING_ALGORITHMS, readonly OidcSigningAlgorithm[]>(true);
      same<Extract<OidcSigningAlgorithm, 'none' | `HS${string}` | `hs${string}`>, never>(true);
      // @ts-expect-error never none
      const none: OidcSigningAlgorithm = 'none';
      // @ts-expect-error never HMAC
      const hs256: OidcSigningAlgorithm = 'HS256';
      // @ts-expect-error never HMAC
      const hs384: OidcSigningAlgorithm = 'HS384';
      // @ts-expect-error never HMAC
      const hs512: OidcSigningAlgorithm = 'HS512';
      // @ts-expect-error a provider's allow-list cannot hold HMAC
      const withHmac: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'c', clientSecret: secret, algorithms: ['RS256', 'HS256'] };
      expect([none, hs256, hs384, hs512, withHmac]).to.have.length(5);
    });

    it('issuer, clientId and the secret ref are enough', () => {
      const minimal: OidcProviderConfig = { issuer: 'https://idp.example/realms/corp', clientId: 'canvas', clientSecret: { secret: 'env://OIDC_SECRET' } };
      const github: OidcProviderConfig = { preset: 'github', clientId: 'Iv1.x', clientSecret: secret };
      const ghes: OidcProviderConfig = { preset: 'github', host: 'github.corp.example', userinfo: true, clientId: 'Iv1.x', clientSecret: secret };
      const entra: OidcProviderConfig = { preset: 'entra', tenant: TENANT, clientId: 'c', clientSecret: secret };
      const oktaOrg: OidcProviderConfig = { preset: 'okta', domain: 'corp.okta.com', authorizationServer: null, clientId: 'c', clientSecret: secret };
      const config: OidcConfig = { providers: { corp: minimal, github, ghes, entra, oktaOrg }, redirects: { success: '/app', failure: '/login?failed' } };
      expect(Object.keys(config.providers)).to.deep.eq(['corp', 'github', 'ghes', 'entra', 'oktaOrg']);
    });

    it('3.0 has confidential clients only', () => {
      // @ts-expect-error a null secret would silently make a public client
      const publicClient: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'canvas', clientSecret: { secret: null } };
      // @ts-expect-error no token endpoint auth 'none'
      const none: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'canvas', clientSecret: secret, tokenEndpointAuth: 'none' };
      expect([publicClient, none]).to.have.length(2);
    });

    it('entra takes one tenant id, never a domain or a multi-tenant alias', () => {
      same<OidcEntraTenantId, `${string}-${string}-${string}-${string}-${string}`>(true);
      // @ts-expect-error multi-tenant is not supported in 3.0
      const common: OidcProviderConfig = { preset: 'entra', tenant: 'common', clientId: 'c', clientSecret: secret };
      // @ts-expect-error a domain does not match the iss of the tenant's tokens
      const domain: OidcProviderConfig = { preset: 'entra', tenant: 'contoso.com', clientId: 'c', clientSecret: secret };
      expect([common, domain]).to.have.length(2);
    });

    it('github cannot turn userinfo off', () => {
      // @ts-expect-error the subject comes from userinfo
      const noUserinfo: OidcProviderConfig = { preset: 'github', userinfo: false, clientId: 'c', clientSecret: secret };
      const generic: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'c', clientSecret: secret, userinfo: false };
      expect([noUserinfo, generic]).to.have.length(2);
    });

    it('post-login redirects are app-relative paths', () => {
      same<OidcAppPath, `/${string}`>(true);
      // @ts-expect-error never an absolute URL
      const absolute: OidcConfig = { providers: {}, redirects: { success: 'https://evil.example/' } };
      // @ts-expect-error never a relative path without the leading slash
      const relative: OidcConfig = { providers: {}, redirects: { failure: 'login' } };
      expect([absolute, relative]).to.have.length(2);
    });

    it('wrong configs do not compile', () => {
      // @ts-expect-error a generic provider needs its issuer
      const noIssuer: OidcProviderConfig = { clientId: 'c', clientSecret: secret };
      // @ts-expect-error the client secret is required
      const noSecret: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'c' };
      // @ts-expect-error the client secret is a ref, never the value
      const literal: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'c', clientSecret: 's3cr3t' };
      // @ts-expect-error clientId is required
      const noClient: OidcProviderConfig = { issuer: 'https://idp.example', clientSecret: secret };
      // @ts-expect-error entra needs one tenant
      const entra: OidcProviderConfig = { preset: 'entra', clientId: 'c', clientSecret: secret };
      // @ts-expect-error keycloak needs its realm
      const keycloak: OidcProviderConfig = { preset: 'keycloak', baseUrl: 'https://kc.example', clientId: 'c', clientSecret: secret };
      // @ts-expect-error auth0 needs its domain
      const auth0: OidcProviderConfig = { preset: 'auth0', clientId: 'c', clientSecret: secret };
      // @ts-expect-error okta needs its domain
      const okta: OidcProviderConfig = { preset: 'okta', clientId: 'c', clientSecret: secret };
      // @ts-expect-error a preset takes its own parameters, not an issuer
      const googleIssuer: OidcProviderConfig = { preset: 'google', issuer: 'https://evil.example', clientId: 'c', clientSecret: secret };
      // @ts-expect-error a plain OAuth2 preset has no issuer either
      const githubIssuer: OidcProviderConfig = { preset: 'github', issuer: 'https://evil.example', clientId: 'c', clientSecret: secret };
      // @ts-expect-error the subject is always mapped
      const noSubject: OidcProviderConfig = { issuer: 'https://idp.example', clientId: 'c', clientSecret: secret, claims: { subject: null } };
      expect([noIssuer, noSecret, literal, noClient, entra, keycloak, auth0, okta, googleIssuer, githubIssuer, noSubject]).to.have.length(11);
    });

    it('no option selects an implicit or hybrid flow or turns PKCE off', () => {
      same<Extract<KeysOf<OidcProviderConfig>, 'responseType' | 'response_type' | 'responseMode' | 'response_mode' | 'flow' | 'grantType' | 'grant_type' | 'pkce' | 'codeChallengeMethod' | 'implicit'>, never>(true);
      const base = { issuer: 'https://idp.example', clientId: 'c', clientSecret: secret } as const;
      // @ts-expect-error no response type switch
      const a: OidcProviderConfig = { ...base, responseType: 'id_token token' };
      // @ts-expect-error no flow switch
      const b: OidcProviderConfig = { ...base, flow: 'implicit' };
      // @ts-expect-error PKCE cannot be turned off
      const c: OidcProviderConfig = { ...base, pkce: false };
      // @ts-expect-error extra parameters cannot set the response type
      const d: OidcProviderConfig = { ...base, authorizationParams: { response_type: 'token' } };
      // @ts-expect-error extra parameters cannot weaken PKCE
      const e: OidcProviderConfig = { ...base, authorizationParams: { code_challenge_method: 'plain' } };
      // @ts-expect-error extra parameters cannot set the response mode
      const f: OidcProviderConfig = { ...base, authorizationParams: { response_mode: 'fragment' } };
      // @ts-expect-error max_age is reserved: nothing checks auth_time in 3.0
      const g: OidcProviderConfig = { ...base, authorizationParams: { max_age: '0' } };
      // @ts-expect-error acr_values is reserved: nothing checks acr in 3.0
      const h: OidcProviderConfig = { ...base, authorizationParams: { acr_values: 'mfa' } };
      const ok: OidcProviderConfig = { ...base, authorizationParams: { prompt: 'select_account', hd: 'example.com' } };
      expect([a, b, c, d, e, f, g, h, ok]).to.have.length(9);
    });

    it('OidcSecretRef, OidcEndpoints, OidcTokenEndpointAuth and OidcClaimPath are exactly the chosen shapes', () => {
      same<OidcSecretRef, { readonly secret: string }>(true);
      same<OidcEndpoints, { readonly authorization: string; readonly token: string; readonly userinfo: string }>(true);
      same<OidcTokenEndpointAuth, 'client_secret_basic' | 'client_secret_post'>(true);
      same<OidcClaimPath, string | readonly string[]>(true);
      same<OidcStrategyName, `oidc:${string}`>(true);
      same<OidcReservedParam, (typeof RESERVED)[number]>(true);
      same<OidcAuthorizationParams, Readonly<Record<string, string>> & { readonly [P in OidcReservedParam]?: never }>(true);
    });

    it('OidcClaimsMapping is exactly the chosen shape', () => {
      same<OidcClaimsMapping, { readonly subject: OidcClaimPath; readonly email: OidcClaimPath | null; readonly emailVerified: OidcClaimPath | null; readonly name: OidcClaimPath | null; readonly groups: OidcClaimPath | null }>(true);
      const keycloak: OidcClaimsMapping = { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', groups: ['realm_access', 'roles'] };
      const auth0: OidcClaimsMapping = { ...keycloak, groups: 'https://example.com/groups' };
      expect([keycloak, auth0]).to.have.length(2);
    });

    it('OidcClientConfig is exactly the chosen shape', () => {
      same<
        OidcClientConfig,
        {
          readonly clientId: string;
          readonly clientSecret: OidcSecretRef;
          readonly tokenEndpointAuth?: OidcTokenEndpointAuth;
          readonly redirectUri?: string;
          readonly scopes?: readonly string[];
          readonly claims?: Partial<OidcClaimsMapping>;
          readonly algorithms?: readonly OidcSigningAlgorithm[];
          readonly clockSkewSeconds?: number;
          readonly userinfo?: boolean;
          readonly requiredClaims?: Readonly<Record<string, string | number | boolean>>;
          readonly authorizationParams?: OidcAuthorizationParams;
          readonly linking?: { readonly jit?: boolean; readonly byVerifiedEmail?: boolean };
        }
      >(true);
    });

    it('OidcProviderSource selects discovery or one preset with its parameters', () => {
      same<OidcProviderSource, { readonly preset?: undefined; readonly issuer: string } | { readonly preset: 'google' } | { readonly preset: 'entra'; readonly tenant: OidcEntraTenantId } | { readonly preset: 'keycloak'; readonly baseUrl: string; readonly realm: string } | { readonly preset: 'auth0'; readonly domain: string } | { readonly preset: 'okta'; readonly domain: string; readonly authorizationServer?: string | null } | { readonly preset: 'github'; readonly host?: string; readonly userinfo?: true }>(true);
      same<OidcProviderConfig, OidcClientConfig & OidcProviderSource>(true);
      same<Exclude<OidcProviderSource['preset'], undefined>, OidcPresetId>(true);
    });

    it('OidcPreset is exactly the chosen shape', () => {
      same<
        OidcPreset,
        {
          readonly id: OidcPresetId;
          readonly scopes: readonly string[];
          readonly claims: OidcClaimsMapping;
          readonly tokenEndpointAuth: OidcTokenEndpointAuth;
        } & ({ readonly idToken: true; readonly issuer: string; readonly issuerAliases?: readonly string[]; readonly endpoints?: never } | { readonly idToken: false; readonly issuer?: never; readonly issuerAliases?: never; readonly endpoints: OidcEndpoints })
      >(true);
      const google: OidcPreset = { id: 'google', idToken: true, issuer: 'https://accounts.google.com', issuerAliases: ['accounts.google.com'], scopes: ['openid'], claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', groups: null }, tokenEndpointAuth: 'client_secret_basic' };
      expect(google.issuerAliases).to.deep.eq(['accounts.google.com']);
      const claims: OidcClaimsMapping = { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', groups: null };
      const entra: OidcPreset = { id: 'entra', idToken: true, issuer: 'https://login.microsoftonline.com/{tenant}/v2.0', scopes: ['openid', 'email', 'profile'], claims, tokenEndpointAuth: 'client_secret_basic' };
      const github: OidcPreset = {
        id: 'github',
        idToken: false,
        endpoints: { authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user' },
        scopes: ['read:user', 'user:email'],
        claims: { ...claims, subject: 'id', emailVerified: null },
        tokenEndpointAuth: 'client_secret_post',
      };
      // @ts-expect-error an ID-token preset names its issuer
      const noIssuer: OidcPreset = { id: 'google', idToken: true, scopes: [], claims, tokenEndpointAuth: 'client_secret_basic' };
      // @ts-expect-error an OAuth2-only preset has no discovery, so it lists its endpoints
      const noEndpoints: OidcPreset = { id: 'github', idToken: false, scopes: [], claims, tokenEndpointAuth: 'client_secret_post' };
      expect([entra, github, noIssuer, noEndpoints]).to.have.length(4);
    });

    it('OidcConfig, OidcMappedClaims and OidcExternalSubject are exactly the chosen shapes', () => {
      same<OidcConfig, { readonly providers: Readonly<Record<string, OidcProviderConfig>>; readonly redirects?: { readonly success?: OidcAppPath; readonly failure?: OidcAppPath } }>(true);
      same<OidcMappedClaims, { readonly name?: string; readonly groups?: readonly string[]; readonly raw: Readonly<Record<string, unknown>> }>(true);
      same<OidcExternalSubject, { readonly provider: OidcStrategyName; readonly subject: string; readonly email?: string; readonly emailVerified?: boolean; readonly claims: OidcMappedClaims }>(true);
      const asCore: ExternalSubject = { provider: 'oidc:corp', subject: 's', claims: { raw: {} } } satisfies OidcExternalSubject;
      // @ts-expect-error the provider is the strategy name 'oidc:<name>'
      const wrongProvider: OidcExternalSubject = { provider: 'corp', subject: 's', claims: { raw: {} } };
      // @ts-expect-error the mapped claims always carry raw
      const noRaw: OidcExternalSubject = { provider: 'oidc:corp', subject: 's', claims: {} };
      expect([asCore, wrongProvider, noRaw]).to.have.length(3);
    });
  });
});
