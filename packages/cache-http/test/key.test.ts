import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { CacheScope, cacheKey, scopeSegments } from '@spinajs/cache';
import { Container } from '@spinajs/di';
import { IdempotencyScopePart } from '@spinajs/http';
import type { IActionLocalStoregeContext } from '@spinajs/http';
import { UNATTENDED } from '@spinajs/principal';
import type { AuthnFacts, Principal } from '@spinajs/principal';
import { LanguageKeyPart, ResponseCacheKeyPart, keyPartsOf, principalIn, responseCacheKey, responseCacheNamespace, responsePrincipal } from '../src/index.js';
import type { ResponseCacheRequest, ResponseCacheRoute, ResponseCacheScope } from '../src/index.js';

const user = (id: string, more: Partial<Principal> = {}): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {}, ...more });
const store = (values: Record<string, unknown>): IActionLocalStoregeContext => ({ requestId: 'r1', responseStart: new Date(0), responseEnd: new Date(0), responseTime: 0, realIp: undefined, ...values });
const SIGNED_IN: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };
const ANONYMOUS: Principal = { type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: {} };
const ALICE = user('alice');

class TenantPart extends IdempotencyScopePart {
  public partOf(storage: object): string | undefined {
    return 'tenant' in storage && typeof storage.tenant === 'string' ? `tenant:${storage.tenant}` : undefined;
  }
}

class RegionPart extends ResponseCacheKeyPart {
  public partOf(storage: IActionLocalStoregeContext): string | undefined {
    return 'region' in storage && typeof storage.region === 'string' ? `region:${storage.region}` : undefined;
  }
}

const SCOPE_PARTS = [new TenantPart()];
const KEY_PARTS = [new RegionPart(), new LanguageKeyPart()];
const ITEMS: ResponseCacheRoute = { namespace: responseCacheNamespace('get', '/items'), scope: 'principal', vary: ['x-region'] };

interface Ask {
  readonly route?: Partial<ResponseCacheRoute>;
  readonly url?: string;
  readonly headers?: ResponseCacheRequest['headers'];
  readonly storage?: Record<string, unknown>;
}

function keyOf({ route, url = '/items?page=1', headers = { accept: 'application/json' }, storage = { Principal: ALICE } }: Ask = {}): string | undefined {
  return responseCacheKey({ ...ITEMS, ...route }, { originalUrl: url, headers }, store(storage), SCOPE_PARTS, KEY_PARTS);
}

function expectDistinct(asks: readonly Ask[]): void {
  const keys = asks.map((ask) => keyOf(ask));
  expect(keys).to.not.include(undefined);
  keys.forEach((key, i) => expect(keys.indexOf(key), JSON.stringify(asks[i])).to.eq(i));
}

const json = (headers: ResponseCacheRequest['headers']): ResponseCacheRequest['headers'] => ({ accept: 'application/json', ...headers });

describe('response cache key', () => {
  it('keeps requests apart that differ in the route, the URL or a header the key reads', () => {
    expectDistinct([
      {},
      { route: { namespace: responseCacheNamespace('head', '/items') } },
      { route: { namespace: responseCacheNamespace('get', '/items/:id') } },
      ...['/Items?page=1', '/items/?page=1', '/items?page=1&page=2', '/items?page=2&page=1', '/items?page=1,2', '/items?%70age=1', '/items?page=%31', '/items', '/items?'].map((url) => ({ url })),
      ...['/items?q=a+b', '/items?q=a%20b', '/items?q=a/b', '/items?q=a%2Fb', '/items?q=a%2fb'].map((url) => ({ url })),
      { headers: {} },
      ...['', 'undefined', 'null', 'text/html'].map((accept) => ({ headers: { accept } })),
      { headers: json({ 'x-data-transform': 'pure' }) },
      ...['eu', 'us', '', 'undefined', ['eu', 'us'], 'eu, us'].map((region) => ({ headers: json({ 'x-region': region }) })),
      { route: { vary: [] } },
      { route: { vary: ['x-other'] } },
    ]);
  });

  it('reads no header the route does not name, and gives one request one key', () => {
    const key = keyOf();
    expect(keyOf({ headers: json({ 'x-other': '1', cookie: 'sid=1', authorization: 'Bearer t' }) })).to.eq(key);
    expect(keyOf({ route: { vary: ['X-Region'] }, headers: json({ 'x-region': 'eu' }) })).to.eq(keyOf({ headers: json({ 'x-region': 'eu' }) }));
    // V8 holds this slice in two-byte form; hashKey of @spinajs/cache would serialize it as other bytes
    const url = '/items?page=1&sort=name&filter=all';
    expect(keyOf({ url: `ā${url}`.slice(1) })).to.eq(keyOf({ url }));
  });

  it('keeps principals apart: type, id, restriction, delegation, impersonation and the strength of the sign-in', () => {
    const principals: Principal[] = [
      ALICE,
      user('Alice'),
      user('alice '),
      user('user:alice'),
      user('alice', { type: 'user:user' }),
      user('alice', { type: 'service' }),
      user('1'),
      user('alice', { ceiling: { permissions: ['invoice:read'] } }),
      user('alice', { ceiling: { permissions: [] } }),
      user('alice', { ceiling: {} }),
      user('alice', { onBehalfOf: user('bob') }),
      user('alice', { onBehalfOf: user('bob'), delegation: 'inherit' }),
      user('alice', { authn: { ...SIGNED_IN, impersonator: { type: 'user', id: 'root' } } }),
      user('alice', { authn: SIGNED_IN }),
      user('alice', { authn: { ...SIGNED_IN, assurance: 'aal2', mfa: ['totp'] } }),
      user('alice', { authn: { ...SIGNED_IN, strategy: 'oidc:google' } }),
      user('alice', { companions: [{ type: 'user', id: 'bob' }] }),
      user('link-1', { type: 'link', companions: [{ type: 'user', id: 'alice' }] }),
    ];
    expectDistinct(principals.map((principal) => ({ storage: { Principal: principal } })));
    const mfa = (...steps: string[]): Principal => user('alice', { authn: { ...SIGNED_IN, mfa: steps }, attributes: { at: steps.length } });
    expect(responsePrincipal(mfa('totp', 'webauthn'))).to.eq(responsePrincipal(mfa('webauthn', 'totp')));
  });

  it('never keys a per-principal request whose caller is not one authenticated principal', () => {
    const callers = [{}, { Principal: undefined }, { Principal: null }, { Principal: ANONYMOUS }, { Principal: UNATTENDED }, { Principal: 'user:alice' }, { Principal: { type: 'user', id: 1, authenticated: true } }, { Principal: { type: 'user', id: 'alice' } }, { Principal: { ...ALICE, authenticated: 'true' } }, { AuthnPrincipal: ALICE }];
    for (const storage of callers) {
      expect(keyOf({ storage }), JSON.stringify(storage)).to.eq(undefined);
    }
    expect(principalIn(store({ Principal: ALICE }))?.id).to.eq('alice');
    expect(principalIn(store({ Principal: ANONYMOUS }))?.id).to.eq('anonymous');
  });

  it('keys a tenant or shared route without the principal, and never as a per-principal route', () => {
    for (const scope of ['tenant', 'shared'] as const) {
      const keys = [{ Principal: ALICE }, { Principal: user('bob') }, { Principal: ANONYMOUS }, {}].map((storage) => keyOf({ route: { scope }, storage }));
      expect(new Set(keys).size).to.eq(1);
    }
    expectDistinct([{}, { route: { scope: 'tenant' } }, { route: { scope: 'shared' } }]);
  });

  it('keeps tenants apart through the scope parts of the key and through a CacheScope of the store key', () => {
    expectDistinct([{ storage: { Principal: ALICE, tenant: 'acme' } }, { storage: { Principal: ALICE, tenant: 'globex' } }, { storage: { Principal: ALICE, tenant: '' } }, {}]);
    expectDistinct(['acme', 'globex'].map((tenant) => ({ route: { scope: 'shared' }, storage: { tenant } })));
    let tenant: string | null = 'acme';
    class TestTenantScope extends CacheScope {
      public segments(): readonly string[] | null {
        return tenant === null ? null : [tenant];
      }
    }
    const container = new Container();
    container.register(TestTenantScope).as(CacheScope);
    const key = keyOf({ route: { scope: 'shared' } }) ?? '';
    const acme = cacheKey('replies', key, scopeSegments(container) ?? []);
    tenant = 'globex';
    expect(cacheKey('replies', key, scopeSegments(container) ?? [])).to.not.eq(acme);
    tenant = null;
    expect(scopeSegments(container)).to.eq(null);
  });

  it('adds the language and the parts an application registers, sorted', () => {
    expect(keyPartsOf(KEY_PARTS, store({ language: 'pl', region: 'eu' }))).to.deep.eq(['lang:pl', 'region:eu']);
    expect(keyPartsOf(KEY_PARTS, store({}))).to.deep.eq([]);
    expectDistinct([{}, { storage: { Principal: ALICE, language: 'pl' } }, { storage: { Principal: ALICE, language: 'en' } }, { storage: { Principal: ALICE, region: 'eu' } }]);
  });

  describe('as a property of generated requests', () => {
    const ATOMS = ['', '/', '//', '?', '&', '=', ',', ', ', '%', '%2F', '%25', '+', ' ', 'a', 'A', '1', 'undefined', 'null', '"', '\\', '[', ']', ':', 'é', '日本', '😀'];
    const text = fc.array(fc.constantFrom(...ATOMS), { maxLength: 3 }).map((parts) => parts.join(''));
    const optional = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arbitrary, { nil: undefined });
    const headerValue = optional(fc.oneof(text, fc.array(text, { minLength: 1, maxLength: 2 })));
    const caller = fc.record({ type: fc.constantFrom('user', 'User', 'service', 'anonymous'), id: text, authenticated: fc.boolean(), permissions: optional(fc.subarray(['a:read', 'b:read'])), impersonator: optional(text) });
    const generated = fc.record({
      type: fc.constantFrom('get', 'head'),
      path: text,
      scope: fc.constantFrom<ResponseCacheScope>('principal', 'tenant', 'shared'),
      vary: fc.subarray<'x-a' | 'x-b'>(['x-a', 'x-b']),
      url: text,
      headers: fc.record({ accept: headerValue, 'x-data-transform': headerValue, 'x-a': headerValue, 'x-b': headerValue }),
      caller: optional(caller),
      tenant: optional(text),
      language: optional(text),
      noise: fc.record({ header: headerValue, attributes: fc.dictionary(text, text, { maxKeys: 2 }), caller: optional(caller) }),
    });
    type Generated = typeof generated extends fc.Arbitrary<infer T> ? T : never;
    type Caller = NonNullable<Generated['caller']>;

    const principalOf = (c: Caller | undefined, attributes: Record<string, string> = {}): Principal | undefined =>
      c === undefined
        ? undefined
        : user(c.id, { type: c.type, authenticated: c.authenticated, attributes, ...(c.permissions ? { ceiling: { permissions: c.permissions } } : {}), ...(c.impersonator === undefined ? {} : { authn: { ...SIGNED_IN, impersonator: { type: 'user', id: c.impersonator } } }) });

    const keyFor = (g: Generated, noisy = false): string | undefined => {
      const caller = noisy && g.scope !== 'principal' ? g.noise.caller : g.caller;
      const storage = { Principal: principalOf(caller, noisy ? g.noise.attributes : {}), tenant: g.tenant, language: g.language };
      const headers = noisy ? { ...g.headers, 'x-c': g.noise.header } : g.headers;
      return responseCacheKey({ namespace: responseCacheNamespace(g.type, g.path), scope: g.scope, vary: g.vary }, { originalUrl: g.url, headers }, store(storage), SCOPE_PARTS, KEY_PARTS);
    };

    // What the reply may depend on, written out independently of the key: two requests share an entry exactly when it is equal.
    const tagged = (value: unknown): unknown => (value === undefined ? 'absent' : ['given', value]);
    const identity = (g: Generated): string | undefined => {
      const c = g.caller;
      if (g.scope === 'principal' && c?.authenticated !== true) return undefined;
      const principal = g.scope === 'principal' && c ? [c.type, c.id, c.permissions ?? null, c.impersonator ?? null] : null;
      return JSON.stringify([g.type, g.path, g.scope, principal, g.url, tagged(g.headers.accept), tagged(g.headers['x-data-transform']), g.vary.map((name) => [name, tagged(g.headers[name])]), tagged(g.tenant), tagged(g.language)]);
    };

    it('gives two different requests two keys, one request one key, and none to a request without a principal', () => {
      fc.assert(
        fc.property(fc.array(generated, { minLength: 2, maxLength: 25 }), (requests) => {
          const byKey = new Map<string, string>();
          const byIdentity = new Map<string, string>();
          for (const g of requests) {
            const key = keyFor(g);
            const id = identity(g);
            expect(key === undefined, JSON.stringify(g)).to.eq(id === undefined);
            if (key === undefined || id === undefined) continue;
            expect(keyFor(g, true), 'a header or principal the key must not read').to.eq(key);
            expect(byKey.get(key) ?? id).to.eq(id);
            expect(byIdentity.get(id) ?? key).to.eq(key);
            byKey.set(key, id);
            byIdentity.set(id, key);
          }
        }),
        { seed: 20_261_126, numRuns: 400 },
      );
    });
  });
});
