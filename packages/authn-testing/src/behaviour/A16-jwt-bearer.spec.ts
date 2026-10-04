import assert from 'node:assert/strict';
import type { IdentityLinkStore, IdentityRef } from '@spinajs/authn/contracts';
import type { ConfigOverrides, JwtIssuerOverride } from '../harness/config.js';
import type { KitKeyPair } from '../harness/ports.js';
import { b64url, compactJws, generateKeyPair, signCompactJws, startJwksServer } from '../helpers/index.js';
import type { JwksServer } from '../helpers/index.js';
import { ALICE, auth, expectFail, expectFailure, expectSuccess, seedUser } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, Prepared } from './types.js';

const ISSUER = 'https://idp.kit.test';
const AUDIENCE = 'kit-api';
const PROVIDER = `jwt:${ISSUER}`;
const SUBJECT = 'kit-sub-1';
const SECOND = 1000;

interface JwtWorld {
  readonly kp1: KitKeyPair;
  readonly kp2: KitKeyPair;
  readonly jwks: JwksServer;
}

/** `serveBoth`: the JWKS holds kp2 as well. */
const prepareJwt =
  (serveBoth = false) =>
  async (): Promise<Prepared> => {
    const kp1 = generateKeyPair('EdDSA');
    const kp2 = generateKeyPair('ES256');
    const jwks = await startJwksServer(serveBoth ? [kp1, kp2] : [kp1]);
    const world: JwtWorld = { kp1, kp2, jwks };
    return { data: world, close: () => jwks.close() };
  };

const world = (k: CaseKit): JwtWorld => k.prepared!.data as JwtWorld;

/** `jit`: the global authn.linking.jit switch; the issuer's own switch comes through `over.linking`. */
const jwtConfig =
  (over: Partial<JwtIssuerOverride> = {}, jit = false) =>
  (p: Prepared | undefined): ConfigOverrides => {
    const w = p!.data as JwtWorld;
    return {
      authn: {
        jwt: { issuers: [{ issuer: ISSUER, audience: AUDIENCE, jwksUri: w.jwks.url, algorithms: ['EdDSA', 'ES256'], clockSkewSeconds: 30, subjectClaim: 'sub', provider: PROVIDER, ...over }] },
        ...(jit ? { linking: { jit: true, byVerifiedEmail: false } } : {}),
      },
    };
  };

const nowSeconds = (k: CaseKit): number => Math.floor(k.clock.now().getTime() / SECOND);

const claimsAt = (nowS: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, iat: nowS, exp: nowS + 300, ...over });

/** jwt(claims, key = kp1, header = {}). */
const jwt = (k: CaseKit, over: Record<string, unknown> = {}, key: KitKeyPair = world(k).kp1, header: Record<string, unknown> = {}): string => signCompactJws({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header }, claimsAt(nowSeconds(k), over), key);

const linkSubject = async (links: IdentityLinkStore, a: IdentityRef): Promise<void> => {
  await links.link(a, { provider: PROVIDER, subject: SUBJECT });
};

interface RefusedRow {
  readonly label: string;
  readonly token: (k: CaseKit) => string;
  readonly config?: Partial<JwtIssuerOverride>;
  readonly serveBoth?: boolean;
}

const REFUSED_ROWS: readonly RefusedRow[] = [
  { label: 'wrong issuer', token: (k) => jwt(k, { iss: 'https://other.kit.test' }) },
  { label: 'wrong audience', token: (k) => jwt(k, { aud: 'other' }) },
  {
    label: 'alg none',
    token: (k) => compactJws([b64url(JSON.stringify({ alg: 'none', kid: world(k).kp1.kid, typ: 'JWT' })), b64url(JSON.stringify(claimsAt(nowSeconds(k)))), '']),
  },
  {
    label: 'HMAC with the public key',
    token: (k) => {
      const { kp1 } = world(k);
      return signCompactJws({ alg: 'HS256', kid: kp1.kid, typ: 'JWT' }, claimsAt(nowSeconds(k)), { hmacKey: Buffer.from(JSON.stringify(kp1.publicJwk)) });
    },
  },
  { label: 'expired beyond the skew', token: (k) => jwt(k, { exp: nowSeconds(k) - 31, iat: nowSeconds(k) - 331 }) },
  { label: 'nbf beyond the skew', token: (k) => jwt(k, { nbf: nowSeconds(k) + 31 }) },
  { label: 'algorithm not allowed', token: (k) => jwt(k, {}, world(k).kp2), config: { algorithms: ['EdDSA'] }, serveBoth: true },
];

export const A16: AuthnRule = defineRule('A16', 'JWT bearers only from configured issuers and links', [
  defineCase({
    name: 'A16 a JWT from a configured issuer maps sub through its link',
    facet: 'A16/jwt',
    needs: ['service', 'links', 'seed'],
    prepare: prepareJwt(),
    config: jwtConfig(),
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await linkSubject(h.links, a);
      const r = await auth(h, k, { kind: 'bearer', token: jwt(k) }, { purpose: 'request' });
      expectSuccess(r);
      assert.deepStrictEqual({ ...r.identity }, { ...a });
    },
  }),
  table(REFUSED_ROWS, (row) =>
    defineCase({
      name: `A16 a JWT is refused: ${row.label}`,
      facet: 'A16/jwt',
      needs: ['service', 'links', 'seed'],
      prepare: prepareJwt(row.serveBoth),
      config: jwtConfig(row.config),
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        await linkSubject(h.links, a);
        expectFail(await auth(h, k, { kind: 'bearer', token: row.token(k) }, { purpose: 'request' }));
      },
    }),
  ),
  defineCase({
    name: 'A16 exp within the skew is accepted',
    facet: 'A16/jwt',
    needs: ['service', 'links', 'seed'],
    prepare: prepareJwt(),
    config: jwtConfig(),
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await linkSubject(h.links, a);
      const nowS = nowSeconds(k);
      expectSuccess(await auth(h, k, { kind: 'bearer', token: jwt(k, { exp: nowS - 10, iat: nowS - 310 }) }, { purpose: 'request' }));
    },
  }),
  defineCase({
    name: 'A16 nbf within the skew is accepted',
    facet: 'A16/jwt',
    needs: ['service', 'links', 'seed'],
    prepare: prepareJwt(),
    config: jwtConfig(),
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await linkSubject(h.links, a);
      expectSuccess(await auth(h, k, { kind: 'bearer', token: jwt(k, { nbf: nowSeconds(k) + 10 }) }, { purpose: 'request' }));
    },
  }),
  defineCase({
    name: 'A16 an unknown kid refreshes the JWKS at most once a minute',
    facet: 'A16/jwt',
    needs: ['service', 'links', 'seed', 'fakeDate'],
    prepare: prepareJwt(),
    config: jwtConfig(),
    async run(h, k) {
      const { kp1, kp2, jwks } = world(k);
      const a = await seedUser(h, ALICE);
      await linkSubject(h.links, a);
      const request = (key: KitKeyPair) => auth(h, k, { kind: 'bearer', token: jwt(k, {}, key) }, { purpose: 'request' });
      expectSuccess(await request(kp1));
      const before = jwks.hits();
      // +31 s, +62 s and +80 s from the first request
      for (const seconds of [31, 31, 18]) {
        k.clock.tick(seconds * SECOND);
        expectFail(await request(kp2), `a kp2 token ${seconds} s later while kp2 is not served`);
      }
      assert.ok(jwks.hits() - before <= 1, `${jwks.hits() - before} JWKS fetches in 80 s`);
      jwks.setKeys([kp1, kp2]);
      k.clock.tick(43 * SECOND);
      expectSuccess(await request(kp2), 'kp2 is served and the cooldown has passed');
    },
  }),
  defineCase({
    name: 'A16 an unknown subject fails with not_linked while JIT is off',
    facet: 'A16/jwt',
    needs: ['service', 'seed'],
    prepare: prepareJwt(),
    config: jwtConfig(),
    async run(h, k) {
      await seedUser(h, ALICE);
      expectFailure(await auth(h, k, { kind: 'bearer', token: jwt(k) }, { purpose: 'request' }), 'not_linked');
    },
  }),
  defineCase({
    name: "A16 an unknown subject is provisioned with the global and the issuer's JIT switch on",
    facet: 'A16/jwt',
    needs: ['service'],
    prepare: prepareJwt(),
    config: jwtConfig({ linking: { jit: true } }, true),
    async run(h, k) {
      const r = await auth(h, k, { kind: 'bearer', token: jwt(k, { sub: 'kit-sub-new', email: 'new@example.test' }) }, { purpose: 'request' });
      assert.strictEqual(r.status, 'success', `result ${JSON.stringify(r)}`);
    },
  }),
  // K6: JIT turned on for an OIDC provider must not create accounts for any subject of a JWT issuer.
  defineCase({
    name: "A16 the global JIT switch alone does not provision a JWT issuer's subject",
    facet: 'A16/jwt',
    needs: ['service'],
    prepare: prepareJwt(),
    config: jwtConfig({}, true),
    async run(h, k) {
      expectFailure(await auth(h, k, { kind: 'bearer', token: jwt(k, { sub: 'kit-sub-new', email: 'new@example.test' }) }, { purpose: 'request' }), 'not_linked');
    },
  }),
  defineCase({
    name: "A16 the issuer's JIT switch alone does not provision either",
    facet: 'A16/jwt',
    needs: ['service'],
    prepare: prepareJwt(),
    config: jwtConfig({ linking: { jit: true } }),
    async run(h, k) {
      expectFailure(await auth(h, k, { kind: 'bearer', token: jwt(k, { sub: 'kit-sub-new', email: 'new@example.test' }) }, { purpose: 'request' }), 'not_linked');
    },
  }),
]);
