import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { OrmEmailVerificationStore } from '../src/index.js';
import { ENTRIES_TABLE, SOURCES_TABLE, VERDICTS_TABLE } from '../src/tables.js';
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

async function generations(): Promise<string[]> {
  const rows = (await (await driver()).select().from(ENTRIES_TABLE)) as { gen: string }[];
  return [...new Set(rows.map((r) => r.gen))].sort();
}

async function loadedDomains(store: OrmEmailVerificationStore): Promise<string[]> {
  return (await store.loadLists()).map((e) => e.domain).sort();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the write to fail'),
    (err: unknown) => err,
  );
}

const SIMULATED = 'simulated connection loss';
const isSourceUpdate = (b: unknown) => b instanceof UpdateQueryBuilder && b.Table === SOURCES_TABLE;
const isSourceInsert = (b: unknown) => b instanceof InsertQueryBuilder && b.Table === SOURCES_TABLE;
const isEntryInsert = (b: unknown) => b instanceof InsertQueryBuilder && b.Table === ENTRIES_TABLE;
const isEntryDelete = (b: unknown) => b instanceof DeleteQueryBuilder && b.Table === ENTRIES_TABLE;

/** The `nth` statement matching `match` throws; with `runFirst` it reaches the database before the client sees the error. */
function failStatement(d: OrmDriver, match: (builder: unknown) => boolean, { runFirst, nth = 1 }: { runFirst: boolean; nth?: number }): void {
  const execute = d.execute.bind(d);
  let seen = 0;
  d.execute = async (builder) => {
    if (match(builder) && ++seen === nth) {
      if (runFirst) await execute(builder);
      throw new Error(SIMULATED);
    }
    return execute(builder);
  };
}

function restoreExecute(d: OrmDriver): void {
  delete (d as Partial<OrmDriver>).execute;
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

  it('cleanupExpired keeps live generations older than the grace period and reclaims dead ones', async () => {
    const store = await bootStore();
    await store.upsertEntries([
      { domain: 'live.com', kind: 'block', source: 'admin' },
      { domain: 'feed.com', kind: 'block', source: 'feed' },
    ]);
    await (await driver()).update().in(ENTRIES_TABLE).update({ created_at: Date.now() - 2 * HOUR }).where('key', '!=', '');
    const dead = [await insertDeadGeneration(Date.now() - 2 * HOUR), await insertDeadGeneration(Date.now() - 3 * HOUR)];
    const inFlight = await insertDeadGeneration(Date.now());
    expect(await store.cleanupExpired()).to.eq(4);
    for (const gen of dead) expect(await entryCount(gen)).to.eq(0);
    expect(await entryCount(inFlight)).to.eq(2);
    expect(await loadedDomains(store)).to.deep.eq(['feed.com', 'live.com']);
  });

  it('indexes entries by generation and age for the dead-generation sweep', async () => {
    await bootStore();
    const indexes = (await (await driver()).select().from('sqlite_master').where({ type: 'index', tbl_name: ENTRIES_TABLE })) as { sql: string | null }[];
    expect(indexes.some((i) => /\(\W*gen\W*,\W*created_at\W*\)/.test(i.sql ?? ''))).to.eq(true);
  });

  it('skips a cleanup tick while the previous cleanup still runs', async () => {
    const store = await bootStore();
    let runs = 0;
    let release: () => void = () => undefined;
    store.cleanupExpired = async () => {
      runs++;
      await new Promise<void>((resolve) => (release = resolve));
      return 0;
    };
    const first = store['runCleanup']();
    await store['runCleanup']();
    release();
    await first;
    const second = store['runCleanup']();
    release();
    await second;
    expect(runs).to.eq(2);
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

describe('OrmEmailVerificationStore write failures', () => {
  after(disposeStore);
  afterEach(async () => restoreExecute(await driver()));

  async function storeWith(domains: string[]): Promise<{ store: OrmEmailVerificationStore; oldGen: string }> {
    const store = await bootStore();
    await store.replaceSource('feed', 'block', domains);
    const [oldGen] = await generations();
    return { store, oldGen };
  }

  it('reports a write whose compare-and-set landed before the error as successful', async () => {
    const { store, oldGen } = await storeWith(['old.com']);
    const version = await store.listVersion();
    failStatement(await driver(), isSourceUpdate, { runFirst: true });
    await store.replaceSource('feed', 'block', ['new.com']);
    expect(await store.listVersion()).to.not.eq(version);
    expect(await loadedDomains(store)).to.deep.eq(['new.com']);
    expect(await entryCount(oldGen)).to.eq(0);
  });

  it('reports a first write whose source insert landed before the error as successful', async () => {
    const store = await bootStore();
    failStatement(await driver(), isSourceInsert, { runFirst: true });
    await store.replaceSource('feed', 'block', ['new.com']);
    expect(await store.listVersion()).to.not.eq('0');
    expect(await loadedDomains(store)).to.deep.eq(['new.com']);
  });

  it('drops the new generation when a chunk insert fails, and keeps the old set', async () => {
    const { store, oldGen } = await storeWith(['old.com']);
    failStatement(await driver(), isEntryInsert, { runFirst: true, nth: 2 });
    const err = await rejection(store.replaceSource('feed', 'block', Array.from({ length: 450 }, (_, i) => `d${i}.com`)));
    expect(err).to.have.property('message', SIMULATED);
    expect(await generations()).to.deep.eq([oldGen]);
    expect(await loadedDomains(store)).to.deep.eq(['old.com']);
  });

  it('leaves a generation whose compare-and-set failed to the sweep', async () => {
    const { store, oldGen } = await storeWith(['old.com']);
    const d = await driver();
    failStatement(d, isSourceUpdate, { runFirst: false });
    expect(await rejection(store.replaceSource('feed', 'block', ['new.com']))).to.have.property('message', SIMULATED);
    restoreExecute(d);
    const orphan = (await generations()).filter((g) => g !== oldGen);
    expect(orphan).to.have.length(1);
    expect(await loadedDomains(store)).to.deep.eq(['old.com']);

    expect(await store.cleanupExpired()).to.eq(0);
    expect(await entryCount(orphan[0])).to.eq(1);

    await d.update().in(ENTRIES_TABLE).update({ created_at: Date.now() - 2 * HOUR }).where('key', '!=', '');
    expect(await store.cleanupExpired()).to.eq(1);
    expect(await generations()).to.deep.eq([oldGen]);
    expect(await loadedDomains(store)).to.deep.eq(['old.com']);
  });

  it('a failed delete of the old generation does not fail the write', async () => {
    const { store, oldGen } = await storeWith(['old.com']);
    const version = await store.listVersion();
    failStatement(await driver(), isEntryDelete, { runFirst: false });
    await store.replaceSource('feed', 'block', ['new.com']);
    expect(await store.listVersion()).to.not.eq(version);
    expect(await loadedDomains(store)).to.deep.eq(['new.com']);
    expect(await entryCount(oldGen)).to.eq(1);
  });
});
