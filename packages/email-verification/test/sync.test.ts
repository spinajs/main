import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { EmailVerificationStore } from '../src/contracts.js';
import { SafeFetch } from '../src/safe-fetch.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { DomainListSync, parseList } from '../src/sync.js';
import { boot, json, shutdown, stubFetch, text } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const URL_A = 'https://lists.example/a.txt';
const URL_B = 'https://lists.example/b.json';
const SOURCES = [
  { name: 'a', url: URL_A, kind: 'block', format: 'lines' },
  { name: 'b', url: URL_B, kind: 'allow', format: 'json' },
];
const sync = () => boot(DomainListSync, { lists: { sources: SOURCES } }, [SafeFetch, EmailVerificationStore, MemoryEmailVerificationStore]);
const store = () => DI.resolve(MemoryEmailVerificationStore);
const domainsOf = async (source: string) =>
  (await (await store()).loadLists())
    .filter((e) => e.source === source)
    .map((e) => e.domain)
    .sort();
const lines = (count: number) => Array.from({ length: count }, (_, i) => `d${i}.com`).join('\n');

describe('parseList', () => {
  it('reads lines, skipping comments, blanks and invalid entries', () => {
    expect(parseList('# c\nMailinator.com\n\nbad_domain\nguerrillamail.com\nmailinator.com\n', 'lines')).to.deep.eq({ domains: ['mailinator.com', 'guerrillamail.com'], invalid: 1 });
  });
  it('reads a JSON array of strings', () => {
    expect(parseList('["a.com", 3, "b.com"]', 'json')).to.deep.eq({ domains: ['a.com', 'b.com'], invalid: 1 });
  });
  it('counts a line longer than 253 characters as invalid', () => {
    expect(parseList(`${'a'.repeat(300)}.com
ok.com`, 'lines')).to.deep.eq({ domains: ['ok.com'], invalid: 1 });
  });
  it('throws on JSON that is not an array', () => {
    expect(() => parseList('{"a":1}', 'json')).to.throw();
  });
});

describe('DomainListSync', () => {
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(async () => {
    stub?.restore();
    await shutdown();
  });

  it('replaces each source from its URL', async () => {
    stub = stubFetch((url) => (url === URL_A ? text(200, 'x.com\ny.com\nbad_\n') : json(200, ['ok.com'])));
    const outcomes = await (await sync()).run();
    expect(outcomes).to.deep.eq([
      { source: 'a', status: 'updated', count: 2, invalid: 1 },
      { source: 'b', status: 'updated', count: 1, invalid: 0 },
    ]);
    expect(await domainsOf('a')).to.deep.eq(['x.com', 'y.com']);
    expect((await (await store()).loadLists()).find((e) => e.source === 'b')?.kind).to.eq('allow');
  });

  it('stores the ETag, sends it next time and changes nothing on 304', async () => {
    stub = stubFetch((_, init) => ((init.headers as Record<string, string>)['if-none-match'] === '"v1"' ? text(304, '') : text(200, 'x.com', { etag: '"v1"' })));
    const s = await sync();
    await s.run('a');
    expect(await s.run('a')).to.deep.eq([{ source: 'a', status: 'unchanged' }]);
    expect(await domainsOf('a')).to.deep.eq(['x.com']);
  });

  it('refuses a list that shrank below minKeepRatio', async () => {
    let body = lines(10);
    stub = stubFetch(() => text(200, body));
    const s = await sync();
    await s.run('a');
    body = lines(4);
    expect(await s.run('a')).to.deep.eq([{ source: 'a', status: 'refused', count: 4, invalid: 0 }]);
    expect(await domainsOf('a')).to.have.length(10);
  });

  it('keeps the old list when the fetch fails', async () => {
    let fail = false;
    stub = stubFetch(() => (fail ? text(500, '') : text(200, 'x.com')));
    const s = await sync();
    await s.run('a');
    fail = true;
    const [outcome] = await s.run('a');
    expect(outcome).to.include({ source: 'a', status: 'failed' });
    expect(await domainsOf('a')).to.deep.eq(['x.com']);
  });

  it('never touches admin entries', async () => {
    stub = stubFetch(() => text(200, 'x.com'));
    const s = await sync();
    await (await store()).upsertEntries([{ domain: 'mine.com', kind: 'block', source: 'admin' }]);
    await s.run('a');
    expect(await domainsOf('admin')).to.deep.eq(['mine.com']);
  });

  const etagSent = (calls: { init: RequestInit }[], i: number) => (calls[i].init.headers as Record<string, string>)['if-none-match'];
  const sources = (s: DomainListSync) => (s as unknown as { Options: { sources: Record<string, unknown>[] } }).Options.sources;

  it('forgets the ETag when a later 200 carries none', async () => {
    let n = 0;
    stub = stubFetch(() => (n++ === 0 ? text(200, 'x.com', { etag: '"v1"' }) : text(200, 'x.com')));
    const s = await sync();
    await s.run('a');
    await s.run('a');
    await s.run('a');
    expect(etagSent(stub.calls, 1)).to.eq('"v1"');
    expect(etagSent(stub.calls, 2)).to.be.undefined;
  });

  it('ignores the stored ETag and count after the URL changes', async () => {
    let body = lines(10);
    stub = stubFetch(() => text(200, body, { etag: '"v1"' }));
    const s = await sync();
    await s.run('a');
    sources(s)[0].url = 'https://lists.example/other.txt';
    body = lines(2);
    const [outcome] = await s.run('a');
    expect(etagSent(stub.calls, 1)).to.be.undefined;
    expect(outcome).to.include({ status: 'updated', count: 2 });
  });

  it('clears the old kind when the kind changes', async () => {
    stub = stubFetch(() => text(200, 'x.com'));
    const s = await sync();
    await s.run('a');
    sources(s)[0].kind = 'allow';
    await s.run('a');
    const entries = (await (await store()).loadLists()).filter((e) => e.source === 'a');
    expect(entries.map((e) => e.kind)).to.deep.eq(['allow']);
  });

  it('stores neither ETag nor count for a refused sync', async () => {
    let body = lines(10);
    stub = stubFetch(() => text(200, body, { etag: `"${body.length}"` }));
    const s = await sync();
    await s.run('a');
    body = lines(4);
    await s.run('a');
    await s.run('a');
    expect(etagSent(stub.calls, 2)).to.eq('"69"');
    expect(await (await store()).getMeta('sync:a:count')).to.eq('10');
  });

  it('refuses a list with no valid domain and keeps the old one', async () => {
    let body = 'x.com\ny.com';
    stub = stubFetch(() => text(200, body));
    const s = await sync();
    await s.run('a');
    body = '<html>\n<body>oops</body>\n</html>';
    const [outcome] = await s.run('a');
    expect(outcome).to.include({ status: 'refused', count: 0 });
    expect(await domainsOf('a')).to.deep.eq(['x.com', 'y.com']);
  });

  it('refuses an empty list on the first sync and stores nothing', async () => {
    stub = stubFetch(() => text(200, '<html></html>', { etag: '"e"' }));
    const s = await sync();
    const [outcome] = await s.run('a');
    expect(outcome.status).to.eq('refused');
    expect(await domainsOf('a')).to.deep.eq([]);
    const st = await store();
    expect(await st.getMeta('sync:a:etag')).to.be.null;
    expect(await st.getMeta('sync:a:count')).to.be.null;
    expect(await st.getMeta('sync:a:origin')).to.be.null;
  });

  it('fails on invalid JSON for a json source', async () => {
    stub = stubFetch(() => text(200, 'not json'));
    const [outcome] = await (await sync()).run('b');
    expect(outcome.status).to.eq('failed');
    expect(outcome.error).to.be.a('string').and.not.empty;
  });

  it('carries on with the next source after a failure', async () => {
    stub = stubFetch((url) => (url === URL_A ? text(500, '') : json(200, ['ok.com'])));
    const outcomes = await (await sync()).run();
    expect(outcomes.map((o) => o.status)).to.deep.eq(['failed', 'updated']);
  });

  it('rejects duplicate source names', async () => {
    const s = await boot(DomainListSync, { lists: { sources: [SOURCES[0], { ...SOURCES[0], url: URL_B }] } }, [SafeFetch, EmailVerificationStore, MemoryEmailVerificationStore]);
    await expect(s.run()).to.be.rejectedWith('duplicate list source name');
  });

  it('throws for an unknown source name', async () => {
    await expect((await sync()).run('nope')).to.be.rejectedWith('no list source named nope');
  });
});
