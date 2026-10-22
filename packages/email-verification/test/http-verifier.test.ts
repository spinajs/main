import { expect } from 'chai';
import { SafeFetch } from '../src/safe-fetch.js';
import { HttpDomainVerifier, jsonPath } from '../src/verifiers/http.js';
import { boot, json, shutdown, stubFetch, text } from './support.js';

const provider = (over: Record<string, unknown> = {}) => ({
  name: 'p1',
  url: 'https://api.example/check/{domain}',
  resultPath: 'data.disposable',
  refuseWhen: [true],
  reason: 'disposable',
  ttlSeconds: 600,
  headers: { authorization: 'Bearer k' },
  ...over,
});

const verifier = (providers: unknown[]) => boot(HttpDomainVerifier, { http: { providers } }, [SafeFetch]);

describe('jsonPath', () => {
  it('reads a dotted path', () => expect(jsonPath({ a: { b: [1, { c: 2 }] } }, 'a.b.1.c')).to.eq(2));
  it('is undefined for a missing step', () => expect(jsonPath({ a: 1 }, 'a.b')).to.eq(undefined));
});

describe('HttpDomainVerifier', () => {
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(async () => {
    stub?.restore();
    await shutdown();
  });

  it('refuses when the value at resultPath is in refuseWhen', async () => {
    stub = stubFetch(() => json(200, { data: { disposable: true } }));
    const v = await verifier([provider()]);
    const got = await v.verify('trash.com');
    expect(got).to.deep.eq({ result: 'refuse', reason: 'disposable', source: 'http:p1' });
    expect(v.ttlFor(got)).to.eq(600);
    expect(stub.calls[0].url).to.eq('https://api.example/check/trash.com');
    expect(stub.calls[0].init.headers).to.deep.eq({ authorization: 'Bearer k' });
  });

  it('answers clean, cached for the shortest provider TTL', async () => {
    stub = stubFetch(() => json(200, { data: { disposable: false } }));
    const v = await verifier([provider(), provider({ name: 'p2', ttlSeconds: 300 })]);
    const got = await v.verify('ok.com');
    expect(got).to.deep.eq({ result: 'unknown', reason: 'clean' });
    expect(v.ttlFor(got)).to.eq(300);
    expect(stub.calls).to.have.length(2);
  });

  it('stops at the first provider that refuses', async () => {
    stub = stubFetch(() => json(200, { data: { disposable: true } }));
    await (await verifier([provider(), provider({ name: 'p2' })])).verify('trash.com');
    expect(stub.calls).to.have.length(1);
  });

  for (const [title, answer] of [
    ['a 429', () => text(429, '')],
    ['a 500', () => text(500, '')],
    ['a body that is not JSON', () => text(200, '<html>')],
    ['a missing resultPath', () => json(200, { other: 1 })],
    ['a body over 64 KiB', () => text(200, 'x'.repeat(70 * 1024))],
  ] as const) {
    it(`answers an uncached unknown on ${title}, and still asks the next provider`, async () => {
      let n = 0;
      stub = stubFetch(() => (n++ === 0 ? answer() : json(200, { data: { disposable: false } })));
      const v = await verifier([provider(), provider({ name: 'p2' })]);
      const got = await v.verify('x.com');
      expect(got).to.deep.eq({ result: 'unknown' });
      expect(v.ttlFor(got)).to.eq(0);
      expect(stub.calls).to.have.length(2);
    });
  }

  it('answers unknown with no providers', async () => {
    expect(await (await verifier([])).verify('x.com')).to.deep.eq({ result: 'unknown' });
  });
});
