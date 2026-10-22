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

  it('throws for an unknown source name', async () => {
    await expect((await sync()).run('nope')).to.be.rejectedWith('no list source named nope');
  });
});
