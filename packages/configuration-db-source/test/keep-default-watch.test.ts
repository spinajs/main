import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { testHost } from '@spinajs/authz-testing';

import { DbConfig, DbConfigSourceBotstrapper, DbConfigValueConverter } from '../src/index.js';
import { bootDb, DbHandle } from './support/db.js';

const LIMIT = 'keepDefaultWatch.limit';
const FRESH = 'keepDefaultWatch.fresh';

type ExposedOption = { path: string; options: Record<string, unknown> };

const declared = (path: string, defaultValue: number, watch: boolean): ExposedOption => ({
  path,
  options: { expose: true, defaultValue, exposeOptions: { type: 'number', group: 'test', label: 'From code', watch } },
});

describe('start-up sync of a row whose Default or Watch changed in the database', function () {
  this.timeout(10000);

  let db: DbHandle;
  let sync: (v: ExposedOption) => Promise<void>;

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));
  });

  beforeEach(async () => {
    await DbConfig.destroy().whereIn('Slug', [LIMIT, FRESH]);

    const bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as { Converter: DbConfigValueConverter; saveConfigOptions(v: ExposedOption): Promise<void> };
    internals.Converter = await DI.resolve(DbConfigValueConverter);
    sync = (v) => internals.saveConfigOptions(v);
  });

  after(async () => {
    await db.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  const row = (slug: string) => DbConfig.where('Slug', slug).firstOrFail();

  it('keeps a Default and a switched-off Watch an administrator set, and refreshes the rest from code', async () => {
    await sync(declared(LIMIT, 20, true));
    await DbConfig.update({ Default: '25', Watch: false, Label: 'stale' }).where('Slug', LIMIT);

    await sync(declared(LIMIT, 20, true));

    const stored = await row(LIMIT);
    expect(stored.Default).to.equal(25);
    expect(stored.Watch).to.equal(false);
    expect(stored.Label).to.equal('From code');
  });

  it('keeps a Watch an administrator switched on although the code declares none', async () => {
    await sync(declared(LIMIT, 20, false));
    await DbConfig.update({ Watch: true }).where('Slug', LIMIT);

    await sync(declared(LIMIT, 20, false));

    expect((await row(LIMIT)).Watch).to.equal(true);
  });

  it('gives an option without a row its Default and Watch from code', async () => {
    await sync(declared(FRESH, 20, true));

    const stored = await row(FRESH);
    expect(stored.Default).to.equal(20);
    expect(stored.Value).to.equal(20);
    expect(stored.Watch).to.equal(true);
  });
});
