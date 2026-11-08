import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Connection, ConnectionSessionSettings, ConnectionState, DefaultReplicaRouter, Model, ModelBase, Orm, OrmDriver, Primary, readYourWrites, ReplicaRouter } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const PRIMARY_FILE = join(process.cwd(), 'test', 'routed-primary.sqlite');
const REPLICA_FILE = join(process.cwd(), 'test', 'routed-replica.sqlite');

function removeFiles(): void {
  for (const file of [PRIMARY_FILE, REPLICA_FILE].flatMap((f) => [f, `${f}-wal`, `${f}-shm`])) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}

class RoutedConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-sqlite', Name: 'routed', Filename: PRIMARY_FILE, Replicas: [{ Filename: REPLICA_FILE }], Migration: { OnStartup: false } }],
        },
      },
      mergeArrays,
    );
  }
}

/** Answers no settings, and records which connection asked: RLS settings must reach a replica as they reach the primary. */
class RecordingSettings extends ConnectionSessionSettings {
  public static asked: string[] = [];

  public settings(driver: OrmDriver): Promise<undefined> {
    RecordingSettings.asked.push(driver.Options.Name);
    return Promise.resolve(undefined);
  }
}

@Connection('routed')
@Model('routed_item')
class RoutedItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

async function readName(): Promise<string> {
  return (await RoutedItem.where({ Id: 1 }).firstOrFail()).Name;
}

async function writePrimary(name: string): Promise<void> {
  const item = await RoutedItem.where({ Id: 1 }).onPrimary().firstOrFail();
  item.Name = name;
  await item.update();
}

/**
 * Booted in a child container that isolates singletons, as `createTestApp` does: the router is cached there, and a
 * builder that asked the root `DI` for it would find nothing and silently read the primary.
 */
describe('read replicas on sqlite', function () {
  this.timeout(30000);

  let container: IContainer;
  let orm: Orm;
  let primary: OrmDriver;
  let replica: OrmDriver;

  before(async () => {
    removeFiles();
    DI.clearCache();
    container = DI.child({ isolateSingletons: true });
    container.register(RoutedConf).as(Configuration);
    container.register(SqliteOrmDriver).as('orm-driver-sqlite');
    container.register(RecordingSettings).as(ConnectionSessionSettings);

    orm = await container.resolve(Orm);
    primary = orm.Connections.get('routed')!;
    replica = orm.Replicas.get('routed')![0];

    for (const [driver, name] of [
      [primary, 'primary'],
      [replica, 'replica'],
    ] as Array<[OrmDriver, string]>) {
      await driver.schema().createTable('routed_item', (t) => {
        t.int('Id').primaryKey();
        t.string('Name');
      });
      await driver.insert().into('routed_item').values({ Id: 1, Name: name });
    }
    await orm.reloadTableInfo();
  });

  afterEach(async () => {
    await primary.update().in('routed_item').update({ Name: 'primary' }).where({ Id: 1 });
  });

  after(async () => {
    await orm?.dispose();
    container.unregister(RoutedConf);
    container.clearCache();
    DI.clearCache();
    removeFiles();
  });

  it('reads a model select from the replica', async () => {
    expect(await readName()).to.eq('replica');
  });

  it('finds the router in the container that booted the Orm, not in the root', () => {
    expect(DI.get(ReplicaRouter)).to.eq(undefined);
    expect(container.get(ReplicaRouter)).to.be.instanceOf(DefaultReplicaRouter);
    expect(primary.Container.get(ReplicaRouter)).to.eq(container.get(ReplicaRouter));
  });

  it('reads the primary with onPrimary()', async () => {
    expect((await RoutedItem.where({ Id: 1 }).onPrimary().firstOrFail()).Name).to.eq('primary');
  });

  it('reads its own write inside a read-your-writes scope, and the replica again outside it', async () => {
    await readYourWrites(async () => {
      expect(await readName()).to.eq('replica');
      await writePrimary('written');
      expect(await readName()).to.eq('written');
    });

    expect(await readName()).to.eq('replica');
  });

  it('reads the primary inside a transaction', async () => {
    expect(await primary.transaction(() => readName())).to.eq('primary');
  });

  it('keeps reading the replica after a write when StickyPrimary is off', async () => {
    primary.Options.StickyPrimary = 'off';
    try {
      await readYourWrites(async () => {
        await writePrimary('written');
        expect(await readName()).to.eq('replica');
      });
    } finally {
      primary.Options.StickyPrimary = undefined;
    }
  });

  it('reads the primary when ReadPreference is primary', async () => {
    primary.Options.ReadPreference = 'primary';
    try {
      expect(await readName()).to.eq('primary');
    } finally {
      primary.Options.ReadPreference = undefined;
    }
  });

  it('reads the primary while the replica is unhealthy', async () => {
    const health = replica as unknown as { setState(state: ConnectionState): void };
    health.setState(ConnectionState.Degraded);
    try {
      expect(await readName()).to.eq('primary');
    } finally {
      health.setState(ConnectionState.Connected);
    }
  });

  it('runs a raw driver select on the driver it was taken from', async () => {
    const rows = (await primary.select().from('routed_item').where({ Id: 1 })) as Array<{ Name: string }>;

    expect(rows[0].Name).to.eq('primary');
  });

  it('streams a model select from the replica', async () => {
    const names: string[] = [];
    for await (const item of RoutedItem.select().order('Id').stream()) {
      names.push(item.Name);
    }

    expect(names).to.deep.equal(['replica']);
  });

  it('reads every keyset page of one stream from the same connection', async () => {
    const router = container.get(ReplicaRouter)!;
    await primary.insert().into('routed_item').values({ Id: 2, Name: 'primary' });
    await replica.insert().into('routed_item').values({ Id: 2, Name: 'replica' });
    router.register(primary, [replica, primary]);
    try {
      const names: string[] = [];
      for await (const item of RoutedItem.select().order('Id').stream({ batchSize: 1 })) {
        names.push(item.Name);
      }

      expect(names).to.have.length(2);
      expect(new Set(names).size).to.eq(1);
    } finally {
      router.register(primary, [replica]);
      for (const driver of [primary, replica]) {
        await driver.del().from('routed_item').where({ Id: 2 });
      }
    }
  });

  it('asks the session settings providers on the replica that runs the select', async () => {
    RecordingSettings.asked = [];
    await readName();

    expect(RecordingSettings.asked).to.include(replica.Options.Name);
  });
});
