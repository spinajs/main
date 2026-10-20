import assert from 'node:assert/strict';
import 'mocha';
import { planCases, runAuthnBehaviour, settleCase } from '../src/behaviour/index.js';
import type { Facet, HarnessContext, HarnessFactory, RuleId } from '../src/behaviour/index.js';
import { UnsupportedConfig } from '../src/harness/index.js';
import type { Harness } from '../src/harness/index.js';
import { corsStub } from './reference/cors-stub.js';
import type { CorsStubMutants } from './reference/cors-stub.js';
import { ORIGIN_PARTNER } from '../src/behaviour/steps.js';
import { referenceHttpHarness } from './reference/http-app.js';

function corsFactory(mutants: CorsStubMutants = {}): HarnessFactory {
  return (ctx) => {
    const unsupported = Object.keys(ctx.config).filter((k) => k !== 'http');
    if (unsupported.length > 0) {
      throw new UnsupportedConfig(unsupported);
    }
    return { http: corsStub(ctx.config.http?.cors?.origins, mutants) };
  };
}

runAuthnBehaviour(['A22'], (ctx) => referenceHttpHarness(ctx), { title: 'reference http app: A22/http', facets: ['A22/http'], claim: ['A22/http'] });

runAuthnBehaviour(['A31'], corsFactory(), { title: 'CORS stub: A31/http', facets: ['A31/http'], claim: ['A31/http'] });

const named = (rule: RuleId, facet: Facet, name: string) => {
  const found = planCases([rule], { facets: [facet] }).filter((p) => p.kase.name === name);
  assert.strictEqual(found.length, 1, `one case named ${name}`);
  return found[0];
};

async function assertBites(rule: RuleId, facet: Facet, names: readonly string[], good: HarnessFactory, bad: HarnessFactory): Promise<void> {
  for (const name of names) {
    const ok = await settleCase(named(rule, facet, name), good);
    assert.strictEqual(ok.status, 'passed', `${name} unmutated: ${String(ok.error)}`);
    const failed = await settleCase(named(rule, facet, name), bad);
    assert.strictEqual(failed.status, 'failed', `${name} mutated`);
  }
}

describe('A22 mutant: the CSRF guard is off', () => {
  const off = (ctx: HarnessContext): Harness => referenceHttpHarness({ ...ctx, config: { ...ctx.config, authn: { ...ctx.config.authn, http: { csrf: { enabled: false } } } } });

  it('fails the refusal cases', () => assertBites('A22', 'A22/http', ['A22 SR-12 cross-origin cookie POST refused', 'A22 Origin null is refused', 'A22 no Origin and no fetch metadata is refused'], (ctx) => referenceHttpHarness(ctx), off));
});

describe('A22 mutants seen through the request headers', () => {
  /** The reference app behind a wrapper that rewrites the headers to what the mutant's guard would have seen. */
  const viaHeaders =
    (rewrite: (headers: Record<string, string>, appOrigin: string) => Record<string, string>) =>
    (ctx: HarnessContext): Harness => {
      const base = referenceHttpHarness(ctx);
      const http = base.http!;
      return { ...base, http: { ...http, send: (req) => http.send({ ...req, headers: rewrite(Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), http.origin) }) } };
    };

  it('fails when the origin is matched by prefix', () =>
    assertBites(
      'A22',
      'A22/http',
      ['A22 a longer host is another origin'],
      (ctx) => referenceHttpHarness(ctx),
      viaHeaders((h, app) => (h['origin']?.startsWith(app) ? { ...h, origin: app } : h)),
    ));

  it('fails when a listed origin is matched by prefix', () =>
    assertBites(
      'A22',
      'A22/http',
      ['A22 a longer listed origin is another origin'],
      (ctx) => referenceHttpHarness(ctx),
      viaHeaders((h) => (h['origin']?.startsWith(ORIGIN_PARTNER) ? { ...h, origin: ORIGIN_PARTNER } : h)),
    ));

  it('fails when same-site fetch metadata is accepted', () =>
    assertBites(
      'A22',
      'A22/http',
      ['A22 same-site fetch metadata is refused'],
      (ctx) => referenceHttpHarness(ctx),
      viaHeaders((h) => (h['sec-fetch-site'] === 'same-site' ? { ...h, 'sec-fetch-site': 'same-origin' } : h)),
    ));
});

describe('A31 CORS stub mutants', () => {
  it('fails SR-12 when an empty list still sends CORS headers', () => assertBites('A31', 'A31/http', ['A31 SR-12 empty CORS list sends no CORS headers: origins []', 'A31 empty CORS list sends no CORS headers: origins absent'], corsFactory(), corsFactory({ headersWhenEmpty: true })));

  it('fails the exact-match rows when origins match by prefix', () => assertBites('A31', 'A31/http', ['A31 an origin must match exactly: other port'], corsFactory(), corsFactory({ substringMatch: true })));

  it('fails the exact-match rows when a preflight echoes any origin', () => assertBites('A31', 'A31/http', ['A31 an origin must match exactly: unlisted', 'A31 an origin must match exactly: other port'], corsFactory(), corsFactory({ preflightEchoesAny: true })));

  it("fails when '*' is combined with credentials", () => assertBites('A31', 'A31/http', ["A31 '*' is never combined with credentials"], corsFactory(), corsFactory({ allowAnyWithCredentials: true })));
});
