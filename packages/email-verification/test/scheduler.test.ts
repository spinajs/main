import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
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

const task = () =>
  boot(EmailDomainListSyncTask, { lists: { sources: [{ name: 'a', url: 'https://lists.example/a.txt', kind: 'block' }] } }, [DomainListSync, SafeFetch, EmailVerificationStore, MemoryEmailVerificationStore]);

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
    await expect((await task()).execute({ result: () => undefined } as unknown as RunContext)).to.be.rejectedWith('list sync failed for a');
  });
});
