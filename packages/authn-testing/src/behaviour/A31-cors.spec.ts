import assert from 'node:assert/strict';
import type { HttpResponse } from '../harness/http.js';
import { ORIGIN_EVIL, ORIGIN_PARTNER, sendRaw } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, HarnessWith } from './types.js';

type CorsHarness = HarnessWith<'http'>;

const simple = (h: CorsHarness, origin: string) => sendRaw(h, { method: 'GET', path: h.http.probePath, headers: { origin } });
const preflight = (h: CorsHarness, origin: string) => sendRaw(h, { method: 'OPTIONS', path: h.http.probePath, headers: { origin, 'access-control-request-method': 'POST' } });

const acHeaders = (res: HttpResponse): string[] => Object.keys(res.headers).filter((n) => n.startsWith('access-control-'));

const cors = (origins: readonly string[] | null) => ({ http: { cors: { origins } } });

const EMPTY_ROWS = [
  { name: 'A31 SR-12 empty CORS list sends no CORS headers: origins []', origins: [] },
  { name: 'A31 empty CORS list sends no CORS headers: origins absent', origins: null },
] as const;

const EXACT_ROWS = [
  { label: 'other port', origin: `${ORIGIN_PARTNER}:8443` },
  { label: 'http scheme', origin: ORIGIN_PARTNER.replace('https:', 'http:') },
  { label: 'subdomain', origin: ORIGIN_PARTNER.replace('//', '//sub.') },
  { label: 'unlisted', origin: ORIGIN_EVIL },
] as const;

export const A31: AuthnRule = defineRule('A31', 'CORS allows only listed origins', [
  table(EMPTY_ROWS, (row) =>
    defineCase({
      name: row.name,
      facet: 'A31/http',
      needs: ['http'],
      config: cors(row.origins),
      async run(h) {
        assert.deepStrictEqual(acHeaders(await simple(h, ORIGIN_EVIL)), [], 'a simple request');
        assert.deepStrictEqual(acHeaders(await preflight(h, ORIGIN_EVIL)), [], 'a preflight');
      },
    }),
  ),
  defineCase({
    name: 'A31 a listed origin is echoed with Vary: Origin',
    facet: 'A31/http',
    needs: ['http'],
    config: cors([ORIGIN_PARTNER]),
    async run(h) {
      const res = await simple(h, ORIGIN_PARTNER);
      assert.strictEqual(res.headers['access-control-allow-origin'], ORIGIN_PARTNER);
      assert.ok(/(^|,\s*)origin(\s*,|$)/i.test(res.headers['vary'] ?? ''), `vary is ${res.headers['vary']}`);
    },
  }),
  defineCase({
    name: "A31 a listed origin's preflight is answered",
    facet: 'A31/http',
    needs: ['http'],
    config: cors([ORIGIN_PARTNER]),
    async run(h) {
      assert.strictEqual((await preflight(h, ORIGIN_PARTNER)).headers['access-control-allow-origin'], ORIGIN_PARTNER);
    },
  }),
  table(EXACT_ROWS, (row) =>
    defineCase({
      name: `A31 an origin must match exactly: ${row.label}`,
      facet: 'A31/http',
      needs: ['http'],
      config: cors([ORIGIN_PARTNER]),
      async run(h) {
        assert.strictEqual((await simple(h, row.origin)).headers['access-control-allow-origin'], undefined, 'a simple request');
        assert.strictEqual((await preflight(h, row.origin)).headers['access-control-allow-origin'], undefined, 'a preflight');
      },
    }),
  ),
  defineCase({
    name: "A31 '*' is never combined with credentials",
    facet: 'A31/http',
    needs: ['http'],
    config: cors(['*']),
    async run(h) {
      assert.ok((await simple(h, ORIGIN_EVIL)).headers['access-control-allow-credentials'] !== 'true');
    },
  }),
  defineCase({
    name: 'A31 check-config warns when the list is empty',
    facet: 'A31/config',
    needs: ['boot'],
    async run(h) {
      const f = await h.boot.checkConfig({ config: cors([]) });
      assert.ok(
        f.some((x) => x.topic === 'cors' && x.level === 'warning'),
        `findings ${JSON.stringify(f)}`,
      );
    },
  }),
]);
