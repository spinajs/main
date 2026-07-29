import { Configuration } from '@spinajs/configuration';
import { Class, ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { FakeSqliteDriver, TEST_TABLE_INFO, bootstrapAll, makeDriver, registerFakes, stubDb } from './misc.js';
import { DefaultMigrationService, IMigrationRecord, IMigrationRunOptions, IMigrationUnit, MIGRATION_TABLE_NAME, Migration, MigrationRunner, OrmException, OrmMigration, migrationChecksum } from '../src/index.js';
import { InsertQueryBuilder, UpdateQueryBuilder } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

const expect = chai.expect;

const now = new Date();

const row = (over: Partial<IMigrationRecord>): IMigrationRecord => ({
  Migration: 'X',
  CreatedAt: now,
  StartedAt: now,
  FinishedAt: now,
  RolledBackAt: null,
  Logs: null,
  Checksum: null,
  Batch: 1,
  ...over,
});

/**
 * A registry entry shaped exactly the way `Orm.registerMigration` builds it - the runner reads
 * `name` and `type`, nothing else.
 */
const ci = (type: Class<OrmMigration>): ClassInfo<OrmMigration> => ({ file: `${type.name}.registered`, name: type.name, type });

/**
 * The slice of `Orm` the runner actually consumes.
 */
const ormLike = (migrations: Array<ClassInfo<OrmMigration>>, connections: Array<[string, OrmDriver]>) => ({
  Migrations: migrations,
  Connections: new Map<string, OrmDriver>(connections),
});

/**
 * A driver class distinct from `FakeSqliteDriver`, and the token it is reachable under.
 *
 * Drivers are DI singletons keyed by their class, so two connections that share a driver class
 * resolve to the very same object. The per-connection grouping the runner exists to do would be
 * invisible against one instance wearing two names - these tests need two.
 */
class SecondSqliteDriver extends FakeSqliteDriver {}
const SECOND_DRIVER_TOKEN = 'second-sqlite-driver';

async function makeSecondDriver(connection: string): Promise<FakeSqliteDriver> {
  const conf = await DI.resolve(Configuration);
  const opts = conf.get<any[]>('db.Connections').find((c: any) => c.Name === connection);

  return (await DI.resolve<OrmDriver>(SECOND_DRIVER_TOKEN, [opts])) as FakeSqliteDriver;
}

describe('MigrationRunner', () => {
  /**
   * `@Migration()` registers the decorated class into the ROOT container under `__migrations__`,
   * and that registration outlives the test that declared it. `migration.test.ts` boots a real
   * `Orm` straight out of that registry ( and asserts on how many migrations it found ), so a
   * fake leaked from here would break a suite this file never touches.
   */
  let preRegistered: unknown[] = [];
  const extraRegistrations: Array<Class<unknown>> = [];

  before(() => {
    registerFakes();
    DI.register(SecondSqliteDriver).as(SECOND_DRIVER_TOKEN);
  });

  after(() => {
    DI.unregister(SecondSqliteDriver);
  });

  beforeEach(async () => {
    await bootstrapAll();

    // tracking table already in its current shape, so ensureStorage() adds nothing to the
    // executed-builder list these tests assert on
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = ['Migration', 'CreatedAt', 'StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch'].map((Name) => ({ Name })) as any;

    // copied, not aliased: getRegisteredTypes hands back the registry's own array, which the
    // decorators below then push into - a snapshot that grows with the thing it is measuring
    // reports nothing to clean up
    preRegistered = [...(DI.getRegisteredTypes('__migrations__') ?? [])];
  });

  afterEach(() => {
    for (const t of [...(DI.getRegisteredTypes('__migrations__') ?? [])]) {
      if (!preRegistered.includes(t)) {
        DI.unregister(t as Class<unknown>);
      }
    }

    for (const t of extraRegistrations.splice(0)) {
      DI.unregister(t);
    }

    DI.clearCache();
    sinon.restore();
    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
  });

  it('orders deterministically: timestamp then name', async () => {
    // same timestamp on purpose - without the name tiebreak the order is whatever the registry
    // happened to hold, which differs between a file-scan boot and a programmatic registration
    @Migration('sqlite')
    class Zeta_2021_05_05_05_05_05 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    @Migration('sqlite')
    class Alpha_2021_05_05_05_05_05 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    stubDb([]);

    const calls: string[] = [];
    sinon.stub(Zeta_2021_05_05_05_05_05.prototype, 'up').callsFake(async () => {
      calls.push('Z');
    });
    sinon.stub(Alpha_2021_05_05_05_05_05.prototype, 'up').callsFake(async () => {
      calls.push('A');
    });

    await new MigrationRunner(ormLike([ci(Zeta_2021_05_05_05_05_05), ci(Alpha_2021_05_05_05_05_05)], [['sqlite', driver]])).up();

    expect(calls).to.eql(['A', 'Z']);
  });

  it('groups by connection and hands each service only its own migrations', async () => {
    @Migration('sqlite')
    class GroupA_2021_03_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    @Migration('SampleConnection1')
    class GroupB_2021_03_02_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const sqlite = await makeDriver('sqlite');
    const sample = await makeSecondDriver('SampleConnection1');
    stubDb([]);
    const up = sinon.spy(DefaultMigrationService.prototype, 'up');

    const executed = await new MigrationRunner(
      ormLike(
        [ci(GroupA_2021_03_01_00_00_00), ci(GroupB_2021_03_02_00_00_00)],
        [
          ['sqlite', sqlite],
          ['SampleConnection1', sample],
        ],
      ),
    ).up();

    // one service per connection, each seeing only the migrations declared for it - a service
    // handed a foreign migration would write it into the wrong connection's tracking table
    expect(up.callCount, 'one service per connection').to.eq(2);
    expect(up.getCall(0).args[0].map((u: IMigrationUnit) => u.name)).to.eql(['GroupA_2021_03_01_00_00_00']);
    expect(up.getCall(1).args[0].map((u: IMigrationUnit) => u.name)).to.eql(['GroupB_2021_03_02_00_00_00']);
    expect((up.getCall(0).thisValue as any).driver.Options.Name).to.eq('sqlite');
    expect((up.getCall(1).thisValue as any).driver.Options.Name).to.eq('SampleConnection1');

    expect(executed.map((e) => e.constructor.name)).to.eql(['GroupA_2021_03_01_00_00_00', 'GroupB_2021_03_02_00_00_00']);
  });

  it('throws on invalid migration name', async () => {
    @Migration('sqlite')
    class Broken extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    const up = sinon.spy(Broken.prototype, 'up');

    try {
      await new MigrationRunner(ormLike([ci(Broken)], [['sqlite', driver]])).up();
      expect.fail('should throw');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('invalid name format');
      expect(e.message, 'the operator has to be told which class is wrong').to.contain('Broken');
    }

    expect(up.called, 'an unorderable set must not be half-run').to.be.false;
  });

  it('skips connections gated by OnStartup when force=false', async () => {
    // ConnectionConf sqlite has OnStartup: false
    @Migration('sqlite')
    class Gate_2021_01_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    @Migration('sqlite')
    class Gate_2021_01_02_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    const up = sinon.spy(Gate_2021_01_01_00_00_00.prototype, 'up');
    const up2 = sinon.spy(Gate_2021_01_02_00_00_00.prototype, 'up');
    stubDb([]);

    const orm = ormLike([ci(Gate_2021_01_01_00_00_00), ci(Gate_2021_01_02_00_00_00)], [['sqlite', driver]]);
    const gated = new MigrationRunner(orm);
    const warn = sinon.spy((gated as any).Log, 'warn');

    await gated.up(undefined, { force: false });
    expect(up.called).to.be.false;
    expect(up2.called).to.be.false;

    // the gate is a property of the connection, not of the migration - repeating it once per
    // migration turns a boot log into noise nobody reads
    const gatedWarnings = warn.getCalls().filter((c) => String(c.args[0]).includes('OnStartup'));
    expect(gatedWarnings, 'one warning per gated connection').to.have.length(1);
    expect(String(gatedWarnings[0].args[0])).to.contain('sqlite');

    await new MigrationRunner(orm).up(); // force defaults true
    expect(up.calledOnce).to.be.true;
    expect(up2.calledOnce).to.be.true;
  });

  it('falls back to DefaultMigrationService when Service token absent', async () => {
    const driver = await makeDriver();
    expect(driver.Options.Migration?.Service).to.be.undefined;

    @Migration('sqlite')
    class Def_2021_01_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const up = sinon.spy(Def_2021_01_01_00_00_00.prototype, 'up');
    const serviceUp = sinon.spy(DefaultMigrationService.prototype, 'up');
    stubDb([]);

    await new MigrationRunner(ormLike([ci(Def_2021_01_01_00_00_00)], [['sqlite', driver]])).up(); // resolves DefaultMigrationService internally

    expect(up.calledOnce).to.be.true;
    expect(serviceUp.calledOnce, 'the built-in service is what ran it').to.be.true;
  });

  it('resolves custom service from Migration.Service token', async () => {
    const driver = await makeDriver();

    class RecordingService extends DefaultMigrationService {
      public static calls = 0;

      public async up(u: IMigrationUnit[], o?: IMigrationRunOptions) {
        RecordingService.calls++;
        return super.up(u, o);
      }
    }

    DI.register(RecordingService).as('my-migration-service');
    extraRegistrations.push(RecordingService);

    // replaced rather than mutated in place: Options.Migration is the object the Configuration
    // handed out, and mutating it would leak the token into every later resolve
    driver.Options.Migration = { ...driver.Options.Migration, Service: 'my-migration-service' };

    @Migration('sqlite')
    class Cust_2021_01_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const up = sinon.spy(Cust_2021_01_01_00_00_00.prototype, 'up');
    stubDb([]);

    await new MigrationRunner(ormLike([ci(Cust_2021_01_01_00_00_00)], [['sqlite', driver]])).up();

    expect(RecordingService.calls).to.eq(1);
    expect(up.calledOnce, 'a custom service still has to run the migration').to.be.true;
  });

  it('warns and skips migration whose connection is missing', async () => {
    @Migration('nope')
    class Lost_2021_01_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const up = sinon.spy(Lost_2021_01_01_00_00_00.prototype, 'up');
    const runner = new MigrationRunner(ormLike([ci(Lost_2021_01_01_00_00_00)], []));
    const warn = sinon.spy((runner as any).Log, 'warn');

    const result = await runner.up();

    expect(up.called).to.be.false;
    expect(result).to.eql([]);

    // a migration dropped without a word is how a typo in @Migration('...') stays invisible
    const skipped = warn.getCalls().find((c) => String(c.args[0]).includes('Lost_2021_01_01_00_00_00'));
    expect(skipped, 'expected a warning naming the skipped migration').to.not.be.undefined;
    expect(String(skipped!.args[0]), 'and the connection it asked for').to.contain('nope');
  });

  it('down rolls back the last batch, and { all: true } reaches every batch', async () => {
    @Migration('sqlite')
    class DownA_2021_06_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    @Migration('sqlite')
    class DownB_2021_06_02_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    stubDb([row({ Migration: 'DownA_2021_06_01_00_00_00', Batch: 1 }), row({ Migration: 'DownB_2021_06_02_00_00_00', Batch: 2 })]);
    const dA = sinon.spy(DownA_2021_06_01_00_00_00.prototype, 'down');
    const dB = sinon.spy(DownB_2021_06_02_00_00_00.prototype, 'down');

    const runner = new MigrationRunner(ormLike([ci(DownA_2021_06_01_00_00_00), ci(DownB_2021_06_02_00_00_00)], [['sqlite', driver]]));

    expect((await runner.down()).map((e) => e.constructor.name)).to.eql(['DownB_2021_06_02_00_00_00']);
    expect(dA.called, 'only the last batch by default').to.be.false;
    expect(dB.calledOnce).to.be.true;

    // `all` has to reach the service - dropped, this silently becomes another last-batch rollback
    expect((await runner.down(undefined, { all: true })).map((e) => e.constructor.name)).to.eql(['DownB_2021_06_02_00_00_00', 'DownA_2021_06_01_00_00_00']);
    expect(dA.calledOnce).to.be.true;
  });

  it('up({ fake: true }) records the migration without running it', async () => {
    @Migration('sqlite')
    class Fake_2021_07_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    const exec = stubDb([]);
    const up = sinon.spy(Fake_2021_07_01_00_00_00.prototype, 'up');

    const executed = await new MigrationRunner(ormLike([ci(Fake_2021_07_01_00_00_00)], [['sqlite', driver]])).up(undefined, { fake: true });

    expect(up.called, 'fake has to reach the service').to.be.false;
    expect(executed).to.have.length(1);

    const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as InsertQueryBuilder).Table === MIGRATION_TABLE_NAME);
    expect(inserts, 'faking still has to record the migration').to.have.length(1);
    expect((inserts[0].args[0] as InsertQueryBuilder).getColumnValues('FinishedAt')[0]).to.be.instanceOf(Date);
  });

  it('resolve targets the owning connection and hands the unit down so the checksum lands', async () => {
    @Migration('sqlite')
    class Res_2021_04_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const driver = await makeDriver();
    const exec = stubDb([row({ Migration: 'Res_2021_04_01_00_00_00', FinishedAt: null, Logs: 'kaboom' })]);
    const resolve = sinon.spy(DefaultMigrationService.prototype, 'resolve');

    await new MigrationRunner(ormLike([ci(Res_2021_04_01_00_00_00)], [['sqlite', driver]])).resolve('Res_2021_04_01_00_00_00', 'applied');

    expect(resolve.calledOnce).to.be.true;
    expect(resolve.firstCall.args[0]).to.eq('Res_2021_04_01_00_00_00');
    expect(resolve.firstCall.args[1]).to.eq('applied');

    // the runner already holds the class; dropping it here leaves Checksum NULL forever and
    // drift can never be reported for this migration again
    const patch = (exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder).at(-1)!.args[0] as UpdateQueryBuilder<unknown>).Value as any;
    expect(patch.FinishedAt).to.be.instanceOf(Date);
    expect(patch.Checksum, 'the unit must be handed down so the checksum can be stamped').to.eq(migrationChecksum(Res_2021_04_01_00_00_00));
  });

  it('resolve throws when no registered migration carries that name', async () => {
    const driver = await makeDriver();
    stubDb([]);

    try {
      await new MigrationRunner(ormLike([], [['sqlite', driver]])).resolve('Nope_2021_04_02_00_00_00', 'applied');
      expect.fail('should throw');
    } catch (e: any) {
      expect(e).to.be.instanceOf(OrmException);
      expect(e.message).to.contain('Nope_2021_04_02_00_00_00');
    }
  });

  it('status reports every connection', async () => {
    @Migration('sqlite')
    class StatA_2021_08_01_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    @Migration('SampleConnection1')
    class StatB_2021_08_02_00_00_00 extends OrmMigration {
      public async up(_c: OrmDriver) {}
      public async down(_c: OrmDriver) {}
    }

    const sqlite = await makeDriver('sqlite');
    const sample = await makeSecondDriver('SampleConnection1');
    stubDb([row({ Migration: 'StatA_2021_08_01_00_00_00', Batch: 1 })]);

    const st = await new MigrationRunner(
      ormLike(
        [ci(StatA_2021_08_01_00_00_00), ci(StatB_2021_08_02_00_00_00)],
        [
          ['sqlite', sqlite],
          ['SampleConnection1', sample],
        ],
      ),
    ).status();

    expect(st.map((s) => s.name)).to.eql(['StatA_2021_08_01_00_00_00', 'StatB_2021_08_02_00_00_00']);
    expect(st.map((s) => s.connection), 'each entry must say which connection it belongs to').to.eql(['sqlite', 'SampleConnection1']);
    expect(st[0].applied).to.be.true;
    expect(st[1].pending).to.be.true;
  });
});
