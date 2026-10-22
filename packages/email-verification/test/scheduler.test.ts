import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { getScheduleDeclarations } from '@spinajs/scheduler';
import type { RunContext } from '@spinajs/scheduler';
import { EmailVerificationStore } from '../src/contracts.js';
import { SafeFetch } from '../src/safe-fetch.js';
import { EMAIL_DOMAIN_LIST_SYNC_SCHEDULE, EmailDomainListSyncTask } from '../src/scheduler.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { DomainListSync } from '../src/sync.js';
import { boot, shutdown, stubFetch, text } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const task = (sources = [{ name: 'a', url: 'https://lists.example/a.txt', kind: 'block' }]) =>
  boot(EmailDomainListSyncTask, { lists: { sources } }, [DomainListSync, SafeFetch, EmailVerificationStore, MemoryEmailVerificationStore]);

describe('EmailDomainListSyncTask', () => {
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(async () => {
    stub?.restore();
    await shutdown();
  });

  it('declares a daily leader-only schedule', () => {
    const declaration = getScheduleDeclarations().find((d) => d.name === EMAIL_DOMAIN_LIST_SYNC_SCHEDULE);
    expect(declaration?.target).to.eq(EmailDomainListSyncTask);
    expect(declaration?.options).to.deep.include({ every: '24h', runOn: 'leader', overlap: 'skip', misfire: 'run-once' });
  });

  it('records the outcomes as the run result', async () => {
    stub = stubFetch(() => text(200, 'x.com'));
    let result: unknown;
    await (await task()).execute({ result: (r: unknown) => (result = r) } as unknown as RunContext);
    expect(result).to.deep.eq([{ source: 'a', status: 'updated', count: 1, invalid: 0 }]);
  });

  it('fails the run when a source failed, so the scheduler retries it', async () => {
    stub = stubFetch(() => text(500, ''));
    let recorded = false;
    const ctx = { result: () => (recorded = true) } as unknown as RunContext;
    await expect((await task()).execute(ctx)).to.be.rejectedWith('list sync failed: a: answered 500');
    expect(recorded).to.eq(false);
  });

  it('names only the failed source and still stores the others', async () => {
    stub = stubFetch((url) => (url.endsWith('/a.txt') ? text(500, '') : text(200, 'y.com')));
    const sources = [
      { name: 'a', url: 'https://lists.example/a.txt', kind: 'block' },
      { name: 'b', url: 'https://lists.example/b.txt', kind: 'block' },
    ];
    await expect((await task(sources)).execute({ result: () => undefined } as unknown as RunContext)).to.be.rejectedWith('list sync failed: a: answered 500');
    const store = await DI.resolve(EmailVerificationStore);
    const stored = (await store.loadLists()).filter((e) => e.source === 'b');
    expect(stored).to.deep.eq([{ domain: 'y.com', kind: 'block', source: 'b' }]);
  });

  it('caps each failed source error at 200 characters', async () => {
    const stored = new DomainListSync();
    stored.run = async () => [{ source: 'a', status: 'failed', error: 'e'.repeat(500) }];
    const t = await task();
    (t as unknown as { Sync: DomainListSync }).Sync = stored;
    let message = '';
    try {
      await t.execute({ result: () => undefined } as unknown as RunContext);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.match(/^list sync failed: a: e{200}$/);
  });
});
