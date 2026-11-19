import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { InternalLogger } from '@spinajs/internal-logger';
import { testHost } from '@spinajs/authz-testing';

import { DbConfig, DbConfigSourceBotstrapper, DbConfigValueConverter } from '../src/index.js';
import { bootDb, DbHandle } from './support/db.js';

const SWITCHED_OFF = 'pollWatchColumn.switchedOff';
const SWITCHED_ON = 'pollWatchColumn.switchedOn';
const UNREADABLE = 'pollWatchColumn.unreadable';

type ExposedOption = { path: string; options: Record<string, unknown> };

const declared = (path: string, watch: boolean): ExposedOption => ({
  path,
  options: { expose: true, defaultValue: 'code', exposeOptions: { type: 'string', group: 'test', watch } },
});

describe('watch poll of a row whose Watch was changed in the database', function () {
  this.timeout(10000);

  let db: DbHandle;
  let bootstrapper: DbConfigSourceBotstrapper;
  let register: (v: ExposedOption) => Promise<void>;

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));
  });

  beforeEach(async () => {
    await DbConfig.destroy().whereIn('Slug', [SWITCHED_OFF, SWITCHED_ON, UNREADABLE]);

    bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as { Converter: DbConfigValueConverter; syncConfigOption(v: ExposedOption): Promise<void> };
    internals.Converter = await DI.resolve(DbConfigValueConverter);
    register = (v) => internals.syncConfigOption(v);
  });

  after(async () => {
    await db.dispose();
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  it('does not apply a row whose Watch was switched off, although the code declares watch: true', async () => {
    await register(declared(SWITCHED_OFF, true));
    await DbConfig.update({ Watch: false, Value: 'database' }).where('Slug', SWITCHED_OFF);

    await bootstrapper.refreshWatched();

    expect(db.value(SWITCHED_OFF)).to.equal('code');
  });

  /** Written past the model, whose converter would store any string as valid JSON. */
  const insertUnreadable = (watch: boolean) =>
    DI.get(Orm)!.Connections.get('sqlite')!.insert().into('configuration').values({ Slug: UNREADABLE, Type: 'json', Group: 'test', Value: '{not json', Watch: watch, Exposed: true });

  it('applies a watched row although a row that is not watched holds text its Type cannot read', async () => {
    await insertUnreadable(false);
    await register(declared(SWITCHED_ON, true));
    await DbConfig.update({ Value: 'database' }).where('Slug', SWITCHED_ON);

    await bootstrapper.refreshWatched();

    expect(db.value(SWITCHED_ON)).to.equal('database');
  });

  it('applies the other watched rows when a watched row holds text its Type cannot read, and logs that row once', async () => {
    const error = sinon.stub(InternalLogger, 'error');
    try {
      await insertUnreadable(true);
      await register(declared(SWITCHED_ON, true));
      await DbConfig.update({ Value: 'database' }).where('Slug', SWITCHED_ON);

      await bootstrapper.refreshWatched();
      await bootstrapper.refreshWatched();

      expect(db.value(SWITCHED_ON)).to.equal('database');
      expect(db.value(UNREADABLE)).to.equal(undefined);
      const logged = error.getCalls().filter((c) => c.args[2] === 'configuration-db-source');
      expect(logged).to.have.length(1);
      expect(logged[0].args[0]).to.include({ slug: UNREADABLE });
    } finally {
      error.restore();
    }
  });

  it('applies a row whose Watch was switched on, although the code declares watch: false', async () => {
    await register(declared(SWITCHED_ON, false));
    await DbConfig.update({ Watch: true, Value: 'database' }).where('Slug', SWITCHED_ON);

    await bootstrapper.refreshWatched();

    expect(db.value(SWITCHED_ON)).to.equal('database');
  });
});
