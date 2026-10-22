import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
import { ENTRIES_TABLE, VERDICTS_TABLE } from '../src/tables.js';
import { bootStore, disposeStore, driver, truncate } from './support.js';

let shared: Awaited<ReturnType<typeof bootStore>> | undefined;

storeContract(
  'OrmEmailVerificationStore',
  async () => {
    shared ??= await bootStore();
    await truncate();
    return shared;
  },
  {
    dispose: async () => {
      await disposeStore();
      shared = undefined;
    },
  },
);

const HOUR = 60 * 60 * 1000;

async function insertDeadGeneration(createdAt: number): Promise<string> {
  const gen = randomUUID();
  await (await driver()).insert().into(ENTRIES_TABLE).values(['a.com', 'b.com'].map((domain) => ({ key: `${gen}|${domain}`, gen, domain, created_at: createdAt })));
  return gen;
}

async function entryCount(gen?: string): Promise<number> {
  const d = await driver();
  const rows = (await (gen ? d.select().from(ENTRIES_TABLE).where({ gen }) : d.select().from(ENTRIES_TABLE))) as unknown[];
  return rows.length;
}

function expiredVerdict(domain: string) {
  return { key: `dns:${domain}`, result: 'unknown', reason: null, source: null, checked_at: 1, expires_at: Date.now() - 1000 };
}

describe('OrmEmailVerificationStore extras', () => {
  after(disposeStore);

  it('cleanupExpired deletes expired verdicts only', async () => {
    const store = await bootStore();
    await (await driver()).insert().into(VERDICTS_TABLE).values(expiredVerdict('old.com'));
    await store.setVerdict('dns', 'new.com', { result: 'unknown', checkedAt: 1 }, 600);
    expect(await store.cleanupExpired()).to.eq(1);
    const keys = ((await (await driver()).select().from(VERDICTS_TABLE)) as { key: string }[]).map((r) => r.key);
    expect(keys).to.deep.eq(['dns:new.com']);
  });

  it('cleanupExpired deletes more expired verdicts than one batch holds', async () => {
    const store = await bootStore();
    const d = await driver();
    const expired = Array.from({ length: 1201 }, (_, i) => expiredVerdict(`d${i}.com`));
    for (let i = 0; i < expired.length; i += 100) await d.insert().into(VERDICTS_TABLE).values(expired.slice(i, i + 100));
    expect(await store.cleanupExpired()).to.eq(1201);
    expect((await d.select().from(VERDICTS_TABLE)) as unknown[]).to.have.length(0);
  });

  it('cleanupExpired reclaims entries of a generation no source points at, after a grace period', async () => {
    const store = await bootStore();
    await store.upsertEntries([{ domain: 'live.com', kind: 'block', source: 'admin' }]);
    await (await driver()).update().in(ENTRIES_TABLE).update({ created_at: Date.now() - 2 * HOUR }).where({ domain: 'live.com' });
    const dead = await insertDeadGeneration(Date.now() - 2 * HOUR);
    const inFlight = await insertDeadGeneration(Date.now());
    expect(await store.cleanupExpired()).to.eq(2);
    expect(await entryCount(dead)).to.eq(0);
    expect(await entryCount(inFlight)).to.eq(2);
    expect((await store.loadLists()).map((e) => e.domain)).to.deep.eq(['live.com']);
  });

  it('concurrent upsertEntries on one source keep every entry', async () => {
    const store = await bootStore();
    await Promise.all(['a.com', 'b.com', 'c.com'].map((domain) => store.upsertEntries([{ domain, kind: 'block', source: 'admin' }])));
    expect((await store.loadLists()).map((e) => e.domain).sort()).to.deep.eq(['a.com', 'b.com', 'c.com']);
    expect(await entryCount()).to.eq(3);
  });

  it('concurrent first setVerdict calls of one key both resolve', async () => {
    const store = await bootStore();
    await Promise.all([store.setVerdict('dns', 'x.com', { result: 'allow', checkedAt: 1 }, 600), store.setVerdict('dns', 'x.com', { result: 'refuse', checkedAt: 2 }, 600)]);
    expect((await store.getVerdict('dns', 'x.com'))?.result).to.be.oneOf(['allow', 'refuse']);
  });

  it('concurrent first setMeta calls of one key both resolve', async () => {
    const store = await bootStore();
    await Promise.all([store.setMeta('k', 'one'), store.setMeta('k', 'two')]);
    expect(await store.getMeta('k')).to.be.oneOf(['one', 'two']);
  });

  it('migrates and works on the connection named by emailVerification.orm.connection', async () => {
    const store = await bootStore('other-connection');
    await store.setMeta('k', 'v');
    expect(await store.getMeta('k')).to.eq('v');
  });
});
