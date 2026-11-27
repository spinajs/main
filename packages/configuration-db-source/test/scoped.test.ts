import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { ScopedConfigurationSource } from '@spinajs/configuration-common';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { testHost } from '@spinajs/authz-testing';

import { ConfiguratioDbSource, DbConfig, SHARED_SCOPE, ScopedDbConfiguration } from '../src/index.js';
import type { IConfiguratioDbSourceConfig, ScopedConfigurationRow } from '../src/index.js';
import { asSystem } from '../src/system.js';
import { bootDb } from './support/db.js';
import type { DbHandle } from './support/db.js';
import { scopeMigrationCases } from './support/scope-migration.js';

class EntriesOf extends ConfiguratioDbSource {
  public async read(driver: OrmDriver): Promise<Record<string, unknown>> {
    this.Connection = driver;
    this.Options = { connection: 'default', table: 'configuration' } satisfies IConfiguratioDbSourceConfig;
    return await this.LoadEntries();
  }
}

class FixedRows extends ScopedDbConfiguration {
  public rows: ScopedConfigurationRow[] = [];
  public reads = 0;
  public failing = false;

  protected override read(): Promise<ScopedConfigurationRow[]> {
    this.reads += 1;
    return this.failing ? Promise.reject(new Error('the database is down')) : Promise.resolve(this.rows);
  }
}

const row = (Slug: string, Value: string, Scope: string) => ({ Slug, Value, Scope, Group: 'test', Type: 'string' as const, Watch: true, Exposed: true });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('configuration rows of one scope', function () {
  this.timeout(20000);
  let db: DbHandle;

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));
  });

  after(async () => {
    await db?.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  beforeEach(async () => {
    await asSystem(() => DbConfig.destroy().where('Id', '>', 0));
  });

  it('keeps one row per slug and scope', async () => {
    await asSystem(() => DbConfig.insert(row('scoped.from', 'shared@app.test', SHARED_SCOPE)));
    await asSystem(() => DbConfig.insert(row('scoped.from', 'billing@acme.test', 'tenant:acme')));

    let refused: unknown;
    try {
      await asSystem(() => DbConfig.insert(row('scoped.from', 'again@acme.test', 'tenant:acme')));
    } catch (err) {
      refused = err;
    }
    expect(refused).to.be.instanceOf(Error);
    expect((await asSystem(() => DbConfig.where('Slug', 'scoped.from'))).length).to.equal(2);
  });

  // BET7-G-Q1: with '' as the shared value, update() throws "Field Scope cannot be null" (orm/src/converters.ts:253).
  it('a row inserted without Scope is shared and can be updated through the model', async () => {
    await asSystem(() => DbConfig.insert({ Slug: 'scoped.plain', Value: 'a', Group: 'test', Type: 'string', Watch: false, Exposed: true }));
    const stored = await asSystem(() => DbConfig.where('Slug', 'scoped.plain').first());
    if (!stored) throw new Error('the row was not stored');
    expect(stored.Scope).to.equal(SHARED_SCOPE);

    stored.Value = 'b';
    await asSystem(() => stored.update());

    expect((await asSystem(() => DbConfig.where('Slug', 'scoped.plain').first()))?.Value).to.equal('b');
  });

  it('loads shared rows into the configuration and hands the scoped ones to ScopedDbConfiguration', async () => {
    await asSystem(() => DbConfig.insert(row('scoped.from', 'shared@app.test', SHARED_SCOPE)));
    await asSystem(() => DbConfig.insert(row('scoped.from', 'billing@acme.test', 'tenant:acme')));
    await asSystem(() => DbConfig.insert(row('scoped.only', 'globex', 'tenant:globex')));
    const driver = DI.get(Orm)!.Connections.get('sqlite')!;

    const loaded = await (await DI.resolve(EntriesOf)).read(driver);

    expect(loaded).to.deep.equal({ scoped: { from: 'shared@app.test' } });
    const scoped = await DI.resolve(ScopedDbConfiguration);
    // the instance an overlay reads through the port is the one the source filled
    expect(DI.resolve(Array.ofType(ScopedConfigurationSource))).to.include(scoped);
    expect([...(scoped.valuesOf('tenant:acme') ?? [])]).to.deep.equal([['scoped.from', 'billing@acme.test']]);
    expect([...(scoped.valuesOf('tenant:globex') ?? [])]).to.deep.equal([['scoped.only', 'globex']]);
    expect(scoped.valuesOf('tenant:initech')).to.equal(undefined);
    expect(scoped.valuesOf(SHARED_SCOPE)).to.equal(undefined);
  });

  it('the watch poll applies only the shared row of a slug', async () => {
    await db.seed([{ path: 'scoped.title', value: 'shared' }]);
    await asSystem(() => DbConfig.insert(row('scoped.title', 'acme', 'tenant:acme')));

    await db.poll();

    expect(db.value('scoped.title')).to.equal('shared');
  });

  it('reads the scoped rows again in the background once they are older than ttlMs, and not after dispose', async () => {
    const scoped = new FixedRows();
    scoped.ttlMs = 1;
    scoped.replace([{ scope: 'tenant:acme', slug: 'scoped.from', value: 'old' }]);
    scoped.rows = [{ scope: 'tenant:acme', slug: 'scoped.from', value: 'new' }];

    await wait(5);
    expect(scoped.valuesOf('tenant:acme')?.get('scoped.from')).to.equal('old');
    await scoped.refresh();
    expect(scoped.valuesOf('tenant:acme')?.get('scoped.from')).to.equal('new');

    await scoped.dispose();
    const reads = scoped.reads;
    scoped.rows = [];
    await wait(5);
    scoped.valuesOf('tenant:acme');
    await scoped.refresh();
    expect(scoped.reads).to.equal(reads);
    expect(scoped.valuesOf('tenant:acme')?.get('scoped.from')).to.equal('new');
  });

  it('after a failed read keeps the rows held and waits one ttlMs before reading again', async () => {
    const scoped = new FixedRows();
    scoped.ttlMs = 50;
    scoped.replace([{ scope: 'tenant:acme', slug: 'scoped.from', value: 'old' }]);
    scoped.failing = true;

    await wait(60);
    for (let i = 0; i < 20; i++) {
      expect(scoped.valuesOf('tenant:acme')?.get('scoped.from')).to.equal('old');
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(scoped.reads).to.equal(1);
  });

  it('with ttlMs 0 never reads in the background', async () => {
    const scoped = new FixedRows();
    scoped.ttlMs = 0;
    scoped.replace([]);
    await wait(5);
    scoped.valuesOf('tenant:acme');
    expect(scoped.reads).to.equal(0);
  });

  scopeMigrationCases(async () => DI.get(Orm)!.Connections.get('sqlite')!);
});
