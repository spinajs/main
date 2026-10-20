import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { KeyAlgorithm, SignedRequest } from '@spinajs/authn/contracts';
import type { KitKeyPair } from '../harness/ports.js';
import { generateKeyPair, signHttpRequest } from '../helpers/index.js';
import type { HttpSigParams } from '../helpers/index.js';
import { auth, expectFail, expectSuccess } from './steps.js';
import { nowSeconds, userKey } from './A17-keys-jws.spec.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

const SECOND = 1000;
const NEEDS = ['service', 'keys', 'keyProofs', 'seed'] as const;
const TARGET = 'https://api.kit.test/v1/items?x=1';
const BODY = Buffer.from('{"a":1}', 'utf8');

interface SigWorld {
  readonly kp: KitKeyPair;
  readonly kid: string;
  readonly nowS: number;
  /** signed(o): a POST with a JSON body unless `request` says otherwise. */
  signed(o?: HttpSigParams, over?: { key?: KitKeyPair; request?: Parameters<typeof signHttpRequest>[0] }): SignedRequest;
}

const world = (k: CaseKit, kp: KitKeyPair, kid: string): SigWorld => {
  const nowS = nowSeconds(k);
  return {
    kp,
    kid,
    nowS,
    signed: (o = {}, over = {}) => signHttpRequest(over.request ?? { method: 'POST', targetUri: TARGET, headers: { 'content-type': 'application/json' }, body: BODY }, over.key ?? kp, kid, { created: nowS, expires: nowS + 300, nonce: randomUUID(), ...o }),
  };
};

const request = (signed: SignedRequest) => ({ kind: 'http-signature', request: signed });

const OK_ROWS: readonly { readonly label: string; readonly alg: KeyAlgorithm; readonly sign: (w: SigWorld) => SignedRequest }[] = [
  { label: 'Ed25519 with body', alg: 'EdDSA', sign: (w) => w.signed() },
  { label: 'P-256 with body', alg: 'ES256', sign: (w) => w.signed() },
  { label: 'GET without body covering only @method and @target-uri', alg: 'EdDSA', sign: (w) => w.signed({}, { request: { method: 'GET', targetUri: TARGET } }) },
];

interface RefusedRow {
  readonly label: string;
  readonly sign: (w: SigWorld) => SignedRequest;
  readonly tickSeconds?: number;
}

const REFUSED_ROWS: readonly RefusedRow[] = [
  { label: 'content-digest not covered', sign: (w) => w.signed({ components: ['@method', '@target-uri'] }) },
  { label: 'digest does not match the body', sign: (w) => ({ ...w.signed(), body: Buffer.from('{"a":2}', 'utf8') }) },
  { label: '@method not covered', sign: (w) => w.signed({ components: ['@target-uri', 'content-digest'] }) },
  { label: '@target-uri not covered', sign: (w) => w.signed({ components: ['@method', 'content-digest'] }) },
  { label: 'target changed', sign: (w) => ({ ...w.signed(), targetUri: 'https://api.kit.test/v1/other?x=1' }) },
  { label: 'expires more than 300 s ahead', sign: (w) => w.signed({ expires: w.nowS + 301 }) },
  { label: 'no created', sign: (w) => w.signed({ created: undefined }) },
  { label: 'no expires', sign: (w) => w.signed({ expires: undefined }) },
  { label: 'no nonce', sign: (w) => w.signed({ nonce: undefined }) },
  { label: 'no keyid', sign: (w) => w.signed({ keyid: null }) },
  { label: 'expired', sign: (w) => w.signed(), tickSeconds: 301 },
  { label: 'signed by another key', sign: (w) => w.signed({}, { key: generateKeyPair(w.kp.alg) }) },
];

export const A18: AuthnRule = defineRule('A18', 'HTTP signatures cover method, target and digest, once', [
  table(OK_ROWS, (row) =>
    defineCase({
      name: `A18 a signed request authenticates: ${row.label}`,
      facet: 'A18/core',
      needs: NEEDS,
      async run(h, k) {
        const { owner, kp, kid } = await userKey(h, k, { alg: row.alg });
        const r = await auth(h, k, request(row.sign(world(k, kp, kid))), { purpose: 'request' });
        expectSuccess(r);
        assert.deepStrictEqual({ ...r.identity }, { ...owner });
      },
    }),
  ),
  table(REFUSED_ROWS, (row) =>
    defineCase({
      name: `A18 a signature is refused: ${row.label}`,
      facet: 'A18/core',
      needs: [...NEEDS, 'fakeDate'],
      async run(h, k) {
        const { kp, kid } = await userKey(h, k);
        const signed = row.sign(world(k, kp, kid));
        if (row.tickSeconds) {
          k.clock.tick(row.tickSeconds * SECOND);
        }
        expectFail(await auth(h, k, request(signed), { purpose: 'request' }));
      },
    }),
  ),
  defineCase({
    name: 'A18 a nonce is single use',
    facet: 'A18/core',
    needs: NEEDS,
    async run(h, k) {
      const { kp, kid } = await userKey(h, k);
      const signed = world(k, kp, kid).signed();
      expectSuccess(await auth(h, k, request(signed), { purpose: 'request' }));
      expectFail(await auth(h, k, request(signed), { purpose: 'request' }), 'the same signed request again');
    },
  }),
]);
