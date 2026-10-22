import { expect } from 'chai';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { storeContract } from '@spinajs/email-verification/testing';
import type { ListEntry } from '@spinajs/email-verification';
import { ValidationException } from '../../session-provider-dynamodb/test/fake-dynamo.js';
import { CHUNK_BYTES, chunkByBytes } from '../src/index.js';
import { bootStore, captureWarnings, disposeStore, fake } from './support.js';

const keys = (entries: ListEntry[]) => entries.map((e) => `${e.kind}|${e.source}|${e.domain}`).sort();
const chunkKeys = () => [...fake.items.keys()].filter((k) => k.startsWith('C#'));
const pkOf = (input: Record<string, unknown>) => ((input.Item ?? input.Key) as Record<string, AttributeValue> | undefined)?.pk?.S;
const failure = (name: string) => Object.assign(new Error(name), { name });
const block = (domain: string, source = 'admin'): ListEntry => ({ domain, kind: 'block', source });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

let shared: Awaited<ReturnType<typeof bootStore>> | undefined;

storeContract(
  'DynamoDbEmailVerificationStore',
  async () => {
    shared ??= await bootStore();
    fake.items.clear();
    return shared;
  },
  {
    dispose: async () => {
      await disposeStore();
      shared = undefined;
    },
  },
);

describe('DynamoDbEmailVerificationStore table', () => {
  after(disposeStore);

  it('creates the table keyed by pk and enables TTL on ExpiresAt', async () => {
    await bootStore();
    expect(fake.tableExists).to.eq(true);
    expect(fake.ttlAttribute).to.eq('ExpiresAt');
  });

  it('creates nothing when createTable is false', async () => {
    await bootStore({ createTable: false });
    expect(fake.sent.map((s) => s.command)).to.not.include('CreateTableCommand');
  });

  it('splits a large source into chunks under CHUNK_BYTES', async () => {
    const store = await bootStore();
    await store.replaceSource(
      'big',
      'block',
      Array.from({ length: 20000 }, (_, i) => `domain-${i}.example.com`),
    );
    const chunks = [...fake.items.values()].filter((item) => item.pk.S!.startsWith('C#'));
    expect(chunks.length).to.be.greaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c.Domains.S!)).to.be.at.most(CHUNK_BYTES);
  });

  it('leaves no chunk of an old generation behind', async () => {
    const store = await bootStore();
    await store.replaceSource('src', 'block', ['a.com']);
    await store.replaceSource('src', 'block', ['b.com']);
    expect([...fake.items.keys()].filter((k) => k.startsWith('C#'))).to.have.length(1);
  });

  it('checks TTL instead of enabling it after losing the create race', async () => {
    await bootStore({}, (f) => {
      f.around = async (command, _input, run) => {
        if (command === 'CreateTableCommand') {
          f.tableExists = true;
          f.ttlAttribute = 'ExpiresAt';
        }
        return run();
      };
    });
    expect(fake.sent.map((s) => s.command)).to.not.include('UpdateTimeToLiveCommand');
  });

  it('treats a TTL another instance enabled first as enabled', async () => {
    await bootStore({}, (f) => {
      f.around = async (command, _input, run) => {
        const result = await run();
        if (command === 'UpdateTimeToLiveCommand') throw new ValidationException('TimeToLive is already enabled');
        return result;
      };
    });
    expect(fake.ttlAttribute).to.eq('ExpiresAt');
  });

  it('warns and keeps a TTL enabled on another attribute', async () => {
    const warnings = captureWarnings(await bootStore());
    try {
      await bootStore({}, (f) => {
        f.tableExists = true;
        f.ttlAttribute = 'Other';
      });
      expect(fake.ttlAttribute).to.eq('Other');
      expect(warnings.messages.join('\n')).to.include('Other');
    } finally {
      warnings.restore();
    }
  });
});

describe('DynamoDbEmailVerificationStore writes', () => {
  after(disposeStore);

  it('survives a manifest write that committed but reported a condition failure', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    let armed = true;
    fake.around = async (command, input, run) => {
      const result = await run();
      if (armed && command === 'PutItemCommand' && pkOf(input) === 'S#block#admin') {
        armed = false;
        throw failure('ConditionalCheckFailedException');
      }
      return result;
    };
    await store.upsertEntries([block('b.com')]);
    fake.around = undefined;
    expect(keys(await store.loadLists())).to.deep.eq(['block|admin|a.com', 'block|admin|b.com']);
    expect(chunkKeys()).to.have.length(1);
  });

  it('survives a manifest write that committed but reported a transient error', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    let armed = true;
    fake.around = async (command, input, run) => {
      const result = await run();
      if (armed && command === 'PutItemCommand' && pkOf(input) === 'S#block#admin') {
        armed = false;
        throw failure('InternalServerError');
      }
      return result;
    };
    await store.upsertEntries([block('b.com')]);
    fake.around = undefined;
    expect(keys(await store.loadLists())).to.deep.eq(['block|admin|a.com', 'block|admin|b.com']);
  });

  it('accepts a swap a later writer replaced before the re-read, without replaying', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    let armed = true;
    fake.around = async (command, input, run) => {
      if (armed && command === 'PutItemCommand' && pkOf(input) === 'S#block#admin') {
        armed = false;
        await run();
        await store.upsertEntries([block('c.com')]);
        throw failure('InternalServerError');
      }
      return run();
    };
    await store.upsertEntries([block('b.com')]);
    fake.around = undefined;
    expect(keys(await store.loadLists())).to.deep.eq(['block|admin|a.com', 'block|admin|b.com', 'block|admin|c.com']);
    expect(chunkKeys()).to.have.length(1);
    expect(fake.sent.filter((s) => s.command === 'PutItemCommand' && pkOf(s.input) === 'S#block#admin')).to.have.length(3);
  });

  it('rejects on an unknown outcome that is not ours and keeps the new chunks', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    const before = chunkKeys();
    fake.around = async (command, input, run) => {
      if (command === 'PutItemCommand' && pkOf(input) === 'S#block#admin') throw failure('InternalServerError');
      return run();
    };
    const err = await rejection(store.upsertEntries([block('b.com')]));
    fake.around = undefined;
    expect((err as Error).name).to.eq('InternalServerError');
    expect(chunkKeys().filter((k) => !before.includes(k))).to.have.length(1);
  });

  it('rethrows the original error when the re-read fails too', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    let armed = false;
    fake.around = async (command, input, run) => {
      if (command === 'PutItemCommand' && pkOf(input) === 'S#block#admin') {
        armed = true;
        throw failure('InternalServerError');
      }
      if (armed && command === 'GetItemCommand' && pkOf(input) === 'S#block#admin') throw failure('ThrottlingException');
      return run();
    };
    const err = await rejection(store.upsertEntries([block('b.com')]));
    fake.around = undefined;
    expect((err as Error).name).to.eq('InternalServerError');
  });

  it('keeps the union of two concurrent upserts to one source', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    let fired = false;
    fake.around = async (command, input, run) => {
      const result = await run();
      if (!fired && command === 'PutItemCommand' && pkOf(input)?.startsWith('C#block#admin#')) {
        fired = true;
        await store.upsertEntries([block('c.com')]);
      }
      return result;
    };
    await store.upsertEntries([block('b.com')]);
    fake.around = undefined;
    expect(keys(await store.loadLists())).to.deep.eq(['block|admin|a.com', 'block|admin|b.com', 'block|admin|c.com']);
    expect(chunkKeys()).to.have.length(1);
  });

  it('never loses a source created while it was emptied', async () => {
    const store = await bootStore();
    await store.replaceSource('src', 'block', ['a.com']);
    let fired = false;
    fake.around = async (command, input, run) => {
      const result = await run();
      if (!fired && (command === 'PutItemCommand' || command === 'DeleteItemCommand') && pkOf(input) === 'S#block#src') {
        fired = true;
        await store.upsertEntries([block('x.com', 'src')]);
      }
      return result;
    };
    await store.replaceSource('src', 'block', []);
    fake.around = undefined;
    expect(keys(await store.loadLists())).to.deep.eq(['block|src|x.com']);
  });

  it('reclaims the chunks a writer left behind after its swap', async () => {
    const store = await bootStore();
    await store.replaceSource('src', 'block', ['a.com']);
    const first = chunkKeys();
    fake.around = async (command, input, run) => {
      if (command === 'DeleteItemCommand' && first.includes(pkOf(input)!)) throw failure('crashed');
      return run();
    };
    const warnings = captureWarnings(store);
    try {
      await store.replaceSource('src', 'block', ['b.com']);
      expect(warnings.messages.join('\n')).to.include('Could not drop generation');
    } finally {
      warnings.restore();
      fake.around = undefined;
    }
    expect(chunkKeys()).to.have.length(2);
    await store.replaceSource('src', 'block', ['c.com']);
    expect(chunkKeys()).to.have.length(1);
    expect(keys(await store.loadLists())).to.deep.eq(['block|src|c.com']);
  });

  it('drops the new chunks when a chunk put fails', async () => {
    const store = await bootStore();
    let puts = 0;
    fake.around = async (command, input, run) => {
      if (command === 'PutItemCommand' && pkOf(input)!.startsWith('C#') && ++puts === 2) throw failure('ProvisionedThroughputExceededException');
      return run();
    };
    const err = await rejection(
      store.replaceSource(
        'big',
        'block',
        Array.from({ length: 20000 }, (_, i) => `domain-${i}.example.com`),
      ),
    );
    fake.around = undefined;
    expect((err as Error).name).to.eq('ProvisionedThroughputExceededException');
    expect(chunkKeys()).to.deep.eq([]);
  });

  it('skips a source that stays unreadable and loads the others', async () => {
    const store = await bootStore();
    await store.replaceSource('a', 'block', ['a.com']);
    await store.replaceSource('b', 'block', ['b.com']);
    fake.items.delete(chunkKeys().find((k) => k.startsWith('C#block#a#'))!);
    const warnings = captureWarnings(store);
    try {
      expect(keys(await store.loadLists())).to.deep.eq(['block|b|b.com']);
      expect(warnings.messages).to.have.length(1);
      expect(warnings.messages[0]).to.include('block#a').and.not.include('a.com');
    } finally {
      warnings.restore();
    }
  });

  it('reports a damaged admin source instead of a write race', async () => {
    const store = await bootStore();
    await store.upsertEntries([block('a.com')]);
    fake.items.delete(chunkKeys()[0]);
    const err = await rejection(store.upsertEntries([block('b.com')]));
    expect((err as Error).message).to.include('email domain list S#block#admin is damaged').and.include('chunk 0');
  });

  it('stores ExpiresAt as whole epoch seconds', async () => {
    const store = await bootStore();
    await store.setVerdict('dns', 'a.com', { result: 'refuse', checkedAt: 1 }, 60);
    expect(fake.items.get('V#dns#a.com')!.ExpiresAt.N).to.match(/^\d+$/);
  });

  it('reads verdicts eventually consistent and lists strongly consistent', async () => {
    const store = await bootStore();
    await store.replaceSource('src', 'block', ['a.com']);
    fake.sent.length = 0;
    await store.getVerdict('dns', 'a.com');
    await store.loadLists();
    const reads = fake.sent.filter((s) => s.command === 'GetItemCommand').map((s) => [pkOf(s.input), s.input.ConsistentRead === true]);
    expect(reads[0]).to.deep.eq(['V#dns#a.com', false]);
    expect(reads.slice(1).every(([, consistent]) => consistent)).to.eq(true);
  });

  it('keeps the list version apart from meta keys', async () => {
    const store = await bootStore();
    await store.setMeta('listVersion', 'mine');
    expect(await store.listVersion()).to.not.eq('mine');
  });

  it('chunks by UTF-8 bytes', () => {
    expect(chunkByBytes(['żż', 'żż'], 6)).to.deep.eq([['żż'], ['żż']]);
  });
});
