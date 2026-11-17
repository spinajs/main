import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Class, DI, IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Connection, ConnectionSessionSettings, ConnectionState, DefaultReplicaRouter, HasMany, Migration, Model, ModelBase, Orm, OrmDriver, OrmMigration, Primary, readYourWrites, Relation, ReplicaRouter } from '@spinajs/orm';
import type { IBuilderMiddleware } from '@spinajs/orm';
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
@Model('routed_mark')
class RoutedMark extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public note_id: number;
}

@Connection('routed')
@Model('routed_note')
class RoutedNote extends ModelBase {
  @Primary()
  public Id: number;

  public Body: string;

  public item_id: number;

  @HasMany(RoutedMark, { foreignKey: 'note_id', primaryKey: 'Id' })
  public Marks: Relation<RoutedMark, RoutedNote>;
}

@Connection('routed')
@Model('routed_item')
class RoutedItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(RoutedNote, { foreignKey: 'item_id', primaryKey: 'Id' })
  public Notes: Relation<RoutedNote, RoutedItem>;
}

async function readName(): Promise<string> {
  return (await RoutedItem.where({ Id: 1 }).firstOrFail()).Name;
}

/** A builder middleware that runs `during` while the relations of the select's rows load. */
function whileRelationsLoad(during: () => Promise<void>): IBuilderMiddleware<RoutedItem[]> {
  return { afterQuery: (rows) => rows, modelCreation: () => null, afterHydration: during };
}

/** What a migration's `data()` and its non-transactional `down()` read through the model, right after the DDL. */
const migrationReads: Record<string, string> = {};

function defineSeedMigration(): Class<OrmMigration> {
  @Migration('routed')
  class RoutedSeed_2026_11_08_00_00_00 extends OrmMigration {
    public transaction = false;

    public async up(): Promise<void> {}

    public async down(): Promise<void> {
      migrationReads.down = await readName();
    }

    public async data(): Promise<void> {
      migrationReads.data = await readName();
    }
  }

  return RoutedSeed_2026_11_08_00_00_00;
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
  let seed: Class<OrmMigration>;

  // setState is protected; a test stands in for the health check and for withReconnect giving up
  const setReplicaState = (state: ConnectionState): void => (replica as unknown as { setState(state: ConnectionState): void }).setState(state);

  before(async () => {
    seed = defineSeedMigration();
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
      await driver.schema().createTable('routed_note', (t) => {
        t.int('Id').primaryKey();
        t.int('item_id');
        t.string('Body');
      });
      await driver.insert().into('routed_note').values({ Id: 1, item_id: 1, Body: name });
      await driver.schema().createTable('routed_mark', (t) => {
        t.int('Id').primaryKey();
        t.int('note_id');
        t.string('Body');
      });
      await driver.insert().into('routed_mark').values({ Id: 1, note_id: 1, Body: name });
    }
    await orm.reloadTableInfo();
  });

  afterEach(async () => {
    await primary.update().in('routed_item').update({ Name: 'primary' }).where({ Id: 1 });
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(seed);
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
    setReplicaState(ConnectionState.Degraded);
    try {
      expect(await readName()).to.eq('primary');
    } finally {
      setReplicaState(ConnectionState.Connected);
    }
  });

  it('reads the primary for a row-locking select outside a transaction', async () => {
    expect((await RoutedItem.where({ Id: 1 }).forUpdate().firstOrFail()).Name).to.eq('primary');
  });

  it("reads the primary in a migration's data() and in its down() outside a transaction", async () => {
    await orm.Migrator.migrate({ name: seed.name });
    await orm.Migrator.Runner.down(seed.name);

    expect(migrationReads).to.deep.equal({ data: 'primary', down: 'primary' });
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

  it('loads the relations of an onPrimary() select from the primary', async () => {
    const item = await RoutedItem.where({ Id: 1 }).onPrimary().populate('Notes').firstOrFail();

    expect(item.Notes.map((n) => n.Body)).to.deep.equal(['primary']);
  });

  it('loads nested relations from the connection of the root select', async () => {
    const item = await RoutedItem.where({ Id: 1 })
      .onPrimary()
      .populate('Notes', function () {
        this.populate('Marks');
      })
      .firstOrFail();

    expect(item.Notes.flatMap((n) => n.Marks.map((m) => m.Body))).to.deep.equal(['primary']);
  });

  it('reads the primary in a transaction opened while relations load', async () => {
    let inTransaction: string | undefined;
    const query = RoutedItem.where({ Id: 1 }).middleware(
      whileRelationsLoad(async () => {
        inTransaction = await primary.transaction(() => readName());
      }),
    );

    expect((await query.firstOrFail()).Name).to.eq('replica');
    expect(inTransaction).to.eq('primary');
  });

  it('reads its own write made while relations load', async () => {
    let afterWrite: string | undefined;
    await readYourWrites(async () => {
      const query = RoutedItem.where({ Id: 1 }).middleware(
        whileRelationsLoad(async () => {
          await writePrimary('written');
          afterWrite = await readName();
        }),
      );
      await query.firstOrFail();
    });

    expect(afterWrite).to.eq('written');
  });

  it('routes a relation load again once the connection of its owner is unhealthy', async () => {
    // registered before the populate compiles, so it runs before the relation middleware picks its connection
    const query = RoutedItem.where({ Id: 1 }).middleware(
      whileRelationsLoad(() => {
        setReplicaState(ConnectionState.Degraded);
        return Promise.resolve();
      }),
    );
    try {
      const item = await query.populate('Notes').firstOrFail();

      expect(item.Name).to.eq('replica');
      expect(item.Notes.map((n) => n.Body)).to.deep.equal(['primary']);
    } finally {
      setReplicaState(ConnectionState.Connected);
    }
  });

  it('loads the relations of a select from the connection that read its rows', async () => {
    const router = container.get(ReplicaRouter)!;
    router.register(primary, [replica, primary]);
    try {
      for (let i = 0; i < 4; i++) {
        const item = await RoutedItem.where({ Id: 1 }).populate('Notes').firstOrFail();
        expect(item.Notes.map((n) => n.Body)).to.deep.equal([item.Name]);
      }
    } finally {
      router.register(primary, [replica]);
    }
  });

  it('loads the relations of every stream batch from the stream connection', async () => {
    const router = container.get(ReplicaRouter)!;
    for (const [driver, name] of [
      [primary, 'primary'],
      [replica, 'replica'],
    ] as Array<[OrmDriver, string]>) {
      await driver.insert().into('routed_item').values({ Id: 2, Name: name });
      await driver.insert().into('routed_note').values({ Id: 2, item_id: 2, Body: name });
    }
    router.register(primary, [replica, primary]);
    try {
      const mismatched: number[] = [];
      let read = 0;
      for await (const item of RoutedItem.select().order('Id').populate('Notes').stream({ batchSize: 1 })) {
        read++;
        if (item.Notes.map((n) => n.Body).join() !== item.Name) {
          mismatched.push(item.Id);
        }
      }

      expect(read).to.eq(2);
      expect(mismatched).to.deep.equal([]);
    } finally {
      router.register(primary, [replica]);
      for (const driver of [primary, replica]) {
        await driver.del().from('routed_note').where({ Id: 2 });
        await driver.del().from('routed_item').where({ Id: 2 });
      }
    }
  });
});

class MixedDriverConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-sqlite', Name: 'mixed', Filename: ':memory:', Replicas: [{ Driver: 'orm-driver-postgres' }], Migration: { OnStartup: false } }],
        },
      },
      mergeArrays,
    );
  }
}

describe('read replicas of another driver', () => {
  it('refuses a replica whose driver is not its primary’s, before any connection opens', async () => {
    DI.clearCache();
    const container = DI.child({ isolateSingletons: true });
    container.register(MixedDriverConf).as(Configuration);
    container.register(SqliteOrmDriver).as('orm-driver-sqlite');
    try {
      let error: unknown;
      await Promise.resolve(container.resolve(Orm)).catch((err: unknown) => (error = err));

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain('replica 0 of connection mixed');
    } finally {
      container.clearCache();
      DI.clearCache();
    }
  });
});
