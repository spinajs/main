/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable prettier/prettier */
import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Perf, PerfSink, IPerfMetric } from '@spinajs/log-common';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';
import { TestMigration_2022_02_08_01_13_00 } from './migrations/TestMigration_2022_02_08_01_13_00.js';
import '@spinajs/log';

class RecordingSink extends PerfSink {
  public metrics: IPerfMetric[] = [];
  public collect(m: IPerfMetric): void {
    this.metrics.push(m);
  }
}

function db() {
  return DI.get(Orm)!;
}

describe('orm-sqlite emits exactly one orm.query span per query', () => {
  let sink: RecordingSink;

  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(RecordingSink).as(PerfSink);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);

    sink = (DI.resolve(Array.ofType(PerfSink)) as PerfSink[]).find((s) => s instanceof RecordingSink) as RecordingSink;
    Perf.refreshSinks();

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('produces one ( and only one ) orm.query span for a raw select', async () => {
    // reference the decorated migration class so its `@Migration('sqlite')` side-effect
    // (registration into DI's `__migrations__`) runs, and TS doesn't flag the import as unused.
    expect(TestMigration_2022_02_08_01_13_00.prototype.up).to.be.a('function');

    sink.metrics.length = 0;

    await db().Connections.get('sqlite')!.select().from('user');

    const spans = sink.metrics.filter((m) => m.name === 'orm.query');
    // exactly one — NOT two ( which is what a leftover per-driver Log.write would cause )
    expect(spans).to.have.length(1);
  });

  it('produces one ( and only one ) orm.query span even when the query fails', async () => {
    sink.metrics.length = 0;

    let threw = false;
    try {
      await db().Connections.get('sqlite')!.select().from('table_that_does_not_exist');
    } catch {
      threw = true;
    }

    expect(threw).to.eq(true);

    const spans = sink.metrics.filter((m) => m.name === 'orm.query');
    expect(spans).to.have.length(1);
    expect(spans[0].error).to.not.be.undefined;
  });
});
