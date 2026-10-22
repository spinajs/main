import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { AllowDomains } from '../src/cli/AllowDomains.js';
import { BlockDomains } from '../src/cli/BlockDomains.js';
import { CheckEmail } from '../src/cli/CheckEmail.js';
import { ListDomains } from '../src/cli/ListDomains.js';
import { SyncLists } from '../src/cli/SyncLists.js';
import { UnlistDomains } from '../src/cli/UnlistDomains.js';
import { DomainVerifier, EmailVerificationStore } from '../src/contracts.js';
import { SafeFetch } from '../src/safe-fetch.js';
import { EmailVerification } from '../src/service.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { DomainListSync } from '../src/sync.js';
import { ListVerifier } from '../src/verifiers/list.js';
import { boot, shutdown, stubFetch, text } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TYPES = [DomainListSync, SafeFetch, ListVerifier, DomainVerifier, EmailVerificationStore, MemoryEmailVerificationStore, AllowDomains, BlockDomains, CheckEmail, ListDomains, SyncLists, UnlistDomains];
const OPTIONS = { verifiers: [{ service: 'ListVerifier' }], lists: { sources: [{ name: 'a', url: 'https://lists.example/a.txt', kind: 'block' }] } };
// One boot per test, so every command of a test shares one memory store.
const command = <T>(type: Class<T>) => DI.resolve(type) as Promise<T>;
const entries = async () =>
  (await (await DI.resolve(MemoryEmailVerificationStore)).loadLists())
    .map((e) => `${e.kind}|${e.source}|${e.domain}`)
    .sort();

describe('email-verification CLI', () => {
  let printed: string[];
  const log = console.log;
  beforeEach(async () => {
    await boot(EmailVerification, OPTIONS, TYPES);
    printed = [];
    console.log = (line: string) => printed.push(line);
  });
  afterEach(async () => {
    console.log = log;
    await shutdown();
  });

  it('block adds normalised admin entries, and --mx adds MX hosts', async () => {
    await (await command(BlockDomains)).execute(['Trash.COM', 'trash.com'], {});
    await (await command(BlockDomains)).execute(['mx.trash.io'], { mx: true });
    expect(await entries()).to.deep.eq(['block-mx|admin|mx.trash.io', 'block|admin|trash.com']);
  });

  it('block refuses a value that is not a domain', async () => {
    await expect((await command(BlockDomains)).execute(['not a domain'], {})).to.be.rejectedWith(InvalidArgument);
  });

  it('allow adds admin allow entries', async () => {
    await (await command(AllowDomains)).execute(['ok.com'], {});
    expect(await entries()).to.deep.eq(['allow|admin|ok.com']);
  });

  it('unlist removes entries of one kind and source', async () => {
    await (await command(BlockDomains)).execute(['a.com', 'b.com'], {});
    await (await command(UnlistDomains)).execute(['a.com'], { kind: 'block' });
    expect(await entries()).to.deep.eq(['block|admin|b.com']);
  });

  it('unlist refuses an unknown kind', async () => {
    await expect((await command(UnlistDomains)).execute(['a.com'], { kind: 'nope' })).to.be.rejectedWith(InvalidArgument);
  });

  it('list prints entries sorted, filtered by kind and source', async () => {
    await (await command(BlockDomains)).execute(['b.com', 'a.com'], {});
    await (await command(AllowDomains)).execute(['c.com'], {});
    await (await command(ListDomains)).execute({ kind: 'block' });
    expect(printed).to.deep.eq(['block admin a.com', 'block admin b.com']);
  });

  it('check prints every verifier answer', async () => {
    await (await command(BlockDomains)).execute(['trash.com'], {});
    await (await DI.resolve(ListVerifier)).reload();
    await (await command(CheckEmail)).execute('a@trash.com');
    expect(printed).to.deep.eq(['domain trash.com', 'list refuse listed list:admin']);
  });

  it('sync prints one line per source and sets exit code 1 on a failure', async () => {
    const stub = stubFetch(() => text(500, ''));
    try {
      await (await command(SyncLists)).execute(undefined);
      expect(printed).to.deep.eq(['a failed answered 500']);
      expect(process.exitCode).to.eq(1);
    } finally {
      stub.restore();
      process.exitCode = 0;
    }
  });
});
