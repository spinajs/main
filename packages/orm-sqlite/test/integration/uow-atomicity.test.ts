/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Atomicity of `save()` against a real, on-disk SQLite file.
 *
 *   npm run test:integration --workspace=@spinajs/orm-sqlite
 *
 * On disk rather than `:memory:` on purpose — an in-memory database is torn down with the
 * process, so a rollback that silently did nothing would still look like a pass.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import '@spinajs/log';

import { SqliteOrmDriver } from '../../src/index.js';
import { IntegrationOrder, IntegrationOrderItem } from './models/IntegrationOrder.js';
import './migrations/IntegrationUowMigration_2026_07_26_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

let dbDir: string;
let dbFile: string;

export class UowIntegrationConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        db: {
          Migration: { Startup: false },
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Name: 'sqlite',
              Filename: dbFile,
              Migration: { Table: 'orm_migrations_uow_integration', OnStartup: false },
            },
          ],
        },
      },
      (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

async function boot() {
  DI.register(UowIntegrationConf).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  const orm = await DI.resolve(Orm);
  await orm!.Migration.up();
  await orm!.reloadTableInfo();

  return orm!;
}

/** Reads the table back, so nothing held in memory by the models can mask a bad commit. */
async function readBack(table: string): Promise<any[]> {
  const orm = DI.get(Orm)!;
  return (await orm.Connections.get('sqlite')!.select().from(table).asRaw<any[]>()) as any[];
}

describe('save() atomicity on disk', function () {
  this.timeout(20000);

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'spinajs-uow-'));
    dbFile = join(dbDir, 'uow.sqlite');
    await boot();
  });

  afterEach(async () => {
    const orm = DI.get(Orm);
    if (orm) {
      await orm.Connections.get('sqlite')?.disconnect();
    }
    DI.clearCache();

    // `DI.clearCache()` only drops resolved INSTANCES — the registration survives, and the
    // container resolves the LAST type registered for a token. `Registry.register` also
    // de-duplicates, so a later suite re-registering its own ConnectionConf is a no-op and
    // cannot win the token back. Leaving this registration in place therefore pointed every
    // subsequent suite at `dbFile` — a path inside the temp directory removed on the next
    // line. Unregister explicitly so the leak cannot outlive the suite that created it.
    DI.unregister(UowIntegrationConf);

    rmSync(dbDir, { recursive: true, force: true });
  });

  it('commits the whole graph', async () => {
    const order = new IntegrationOrder({ Total: 5 });
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationOrderItem({ Sku: 'A' }), new IntegrationOrderItem({ Sku: 'B' }));

    await order.save();

    expect(await readBack('integration_order')).to.have.length(1);
    expect(await readBack('integration_order_item')).to.have.length(2);
  });

  it('leaves the file untouched when a statement partway through the graph fails', async () => {
    const order = new IntegrationOrder({ Total: 5 });
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationOrderItem({ Sku: 'A' }), new IntegrationOrderItem({ Sku: 'B' }));

    const connection: any = DI.get(Orm)!.Connections.get('sqlite')!;
    const original = connection.execute.bind(connection);
    let seen = 0;
    connection.execute = async (builder: any) => {
      seen += 1;
      if (seen === 3) {
        throw new Error('boom');
      }
      return await original(builder);
    };

    try {
      await expect(order.save()).to.be.rejectedWith('boom');
    } finally {
      connection.execute = original;
    }

    expect(await readBack('integration_order')).to.have.length(0);
    expect(await readBack('integration_order_item')).to.have.length(0);
  });

  it('rolls back an update and its orphan delete together', async () => {
    const order = new IntegrationOrder({ Total: 5 });
    (order.Items as any).Populated = true;
    order.Items.push(new IntegrationOrderItem({ Sku: 'A' }), new IntegrationOrderItem({ Sku: 'B' }));
    await order.save();

    order.Total = 99;
    order.Items.splice(0, 1);

    const connection: any = DI.get(Orm)!.Connections.get('sqlite')!;
    const original = connection.execute.bind(connection);
    connection.execute = async (builder: any) => {
      const compiled: any = builder.toDB();
      const expression = Array.isArray(compiled) ? compiled[0]?.expression : compiled?.expression;
      if (typeof expression === 'string' && expression.startsWith('DELETE')) {
        throw new Error('boom');
      }
      return await original(builder);
    };

    try {
      await expect(order.save()).to.be.rejectedWith('boom');
    } finally {
      connection.execute = original;
    }

    expect((await readBack('integration_order'))[0].Total).to.equal(5);
    expect(await readBack('integration_order_item')).to.have.length(2);
  });
});
