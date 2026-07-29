import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { MIGRATION_DI_SOURCE, Migration, MigrationSource, Orm, OrmDriver, OrmException, OrmMigration } from '../src/index.js';
import { ConnectionConf, FakeMysqlDriver, bootstrapAll, registerFakes, stubDb } from './misc.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

class MigrationEnvTest_Always_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

class MigrationEnvTest_Local_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

/**
 * Reaches the Orm through the DI registry the decorator writes to - no file suffix in play, which
 * is the shape a package re-exporting its migrations from `index.ts` has.
 */
@Migration('sqlite', { Env: 'local' })
class MigrationEnvTest_Decorated_2026_07_29_10_02_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

/**
 * A source under the test's control, so these cases never depend on files on disk. It reports
 * exactly the entries a test hands it, `file` included - which is what carries the env suffix.
 */
class FakeMigrationSource extends MigrationSource {
  public static Entries: Array<ClassInfo<OrmMigration>> = [];

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    return FakeMigrationSource.Entries;
  }
}

class EnvConf extends ConnectionConf {
  public static Env = 'prod';

  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('process.env.APP_ENV', EnvConf.Env);
  }
}

const entry = (type: any, file: string): ClassInfo<OrmMigration> => ({ file, name: type.name, type });

describe('Orm migration environments', () => {
  before(() => {
    registerFakes();
    // `ConnectionConf` also declares a mysql connection ( see misc.ts ) - every other suite that
    // resolves a real Orm against it registers this fake for the same reason
    DI.register(FakeMysqlDriver).as('mysql');
    DI.register(EnvConf).as(Configuration);
    DI.register(FakeMigrationSource).as(MigrationSource);
  });

  after(() => {
    DI.unregister(FakeMigrationSource);
    // `@Migration` registers into the ROOT container and the registration outlives this file -
    // migration.test.ts asserts on how many migrations the Orm found
    DI.unregister(MigrationEnvTest_Decorated_2026_07_29_10_02_00);
    // registered into the ROOT container in `before()` above - left in place, `EnvConf` (and
    // whatever `EnvConf.Env` its last test set) would outlive this file as every other suite's
    // `Configuration`, and the 'mysql' driver every other suite resolves would stay this file's fake
    DI.unregister(EnvConf);
    DI.unregister(FakeMysqlDriver);
  });

  beforeEach(async () => {
    DI.removeAllListeners('di.resolve.Configuration');
    FakeMigrationSource.Entries = [];
    await bootstrapAll();
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('registers an unsuffixed migration under any environment', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/MigrationEnvTest_Always_2026_07_29_10_00_00.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Always_2026_07_29_10_00_00');
  });

  it('registers a suffixed migration under its own environment', async () => {
    EnvConf.Env = 'local';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('makes a foreign-environment migration entirely invisible', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name)).to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');

    // the full suite may have other, unrelated migrations registered against 'sqlite' at this
    // point (globally-registered fixtures from other spec files) - stubbed so status() reports on
    // whatever it finds instead of crashing on a real, un-mocked select
    stubDb([]);

    // and invisible to the report too, not merely skipped by the run
    const status = await orm.Migration.status();
    expect(status.map((s) => s.name)).to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('keeps the env tag when the same class is reported by a second, untagged origin', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [
      entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js'),
      // the DI registry's view of the very same class, with no suffix to read
      entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '<di>'),
    ];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.map((m) => m.name), 'the untagged duplicate dropped the .local tag').to.not.include('MigrationEnvTest_Local_2026_07_29_10_01_00');
  });

  it('registers a duplicated migration exactly once', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/src/MigrationEnvTest_Always_2026_07_29_10_00_00.js'), entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/lib/MigrationEnvTest_Always_2026_07_29_10_00_00.js')];

    const orm = await DI.resolve(Orm);

    expect(orm.Migrations.filter((m) => m.name === 'MigrationEnvTest_Always_2026_07_29_10_00_00')).to.have.lengthOf(1);
  });

  it('prefers a real path over the DI sentinel when the sentinel entry arrives first', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [
      // the '<di>' sentinel arrives FIRST here - on order alone, a merge that unconditionally keeps
      // `previous.file` would let it win over the real path discovered second, contradicting the
      // intent that every ClassInfo.file carries the migration's actual origin
      entry(MigrationEnvTest_Always_2026_07_29_10_00_00, MIGRATION_DI_SOURCE),
      entry(MigrationEnvTest_Always_2026_07_29_10_00_00, '/app/MigrationEnvTest_Always_2026_07_29_10_00_00.js'),
    ];

    const orm = await DI.resolve(Orm);
    const found = orm.Migrations.find((m) => m.name === 'MigrationEnvTest_Always_2026_07_29_10_00_00');

    expect(found?.file).to.equal('/app/MigrationEnvTest_Always_2026_07_29_10_00_00.js');
  });

  it('warns on a genuine name collision without misdiagnosing it as one migration claiming two environments', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [];

    // primes Orm.prototype's shared `Log` getter - the property decorator caches the resolved
    // logger on first access, on the PROTOTYPE, so any Orm instance's `.Log` from here on is this
    // same object and a spy on it observes what the Orm resolved below logs internally
    const warmup = await DI.resolve(Orm);
    const warn = sinon.spy((warmup as any).Log, 'warn');
    DI.clearCache();

    class MigrationEnvTest_CollisionA_2026_07_29_10_03_00 extends OrmMigration {
      public async up(_c: OrmDriver): Promise<void> {}
      public async down(_c: OrmDriver): Promise<void> {}
    }

    class MigrationEnvTest_CollisionB_2026_07_29_10_03_00 extends OrmMigration {
      public async up(_c: OrmDriver): Promise<void> {}
      public async down(_c: OrmDriver): Promise<void> {}
    }

    // two DISTINCT classes forced to share one name - discoverMigrations groups by `found.name`,
    // which mirrors the class's own `.name` the way every real MigrationSource reports it
    Object.defineProperty(MigrationEnvTest_CollisionB_2026_07_29_10_03_00, 'name', { value: MigrationEnvTest_CollisionA_2026_07_29_10_03_00.name });

    FakeMigrationSource.Entries = [
      // both suffixed with different environments, so the collision scenario exercises the
      // logic that would call mergeMigrationEnv if these were the same class - the prod-suffixed
      // entry stays visible under the current prod environment, so one survivor remains visible
      entry(MigrationEnvTest_CollisionA_2026_07_29_10_03_00, '/app/MigrationEnvTest_CollisionA_2026_07_29_10_03_00.prod.js'),
      entry(MigrationEnvTest_CollisionB_2026_07_29_10_03_00, '/app/MigrationEnvTest_CollisionB_2026_07_29_10_03_00.dev.js'),
    ];

    // must not throw "The same migration cannot belong to two environments" - that would
    // contradict the collision warning below, since these are two UNRELATED classes, not one
    // migration declared for two environments
    const orm = await DI.resolve(Orm);

    expect(warn.getCalls().some((c) => String(c.args[0]).includes('Two different migration classes')), 'expected the collision warning to fire').to.equal(true);

    const survivors = orm.Migrations.filter((m) => m.name === MigrationEnvTest_CollisionA_2026_07_29_10_03_00.name);
    expect(survivors).to.have.lengthOf(1);
    expect(survivors[0].type).to.equal(MigrationEnvTest_CollisionA_2026_07_29_10_03_00);
  });

  it('honours an Env declared on the decorator alone, with no file suffix in play', async () => {
    // registered through DI by the decorator below, not by any source this test controls - the
    // path a package re-exporting its migrations from index.ts takes
    EnvConf.Env = 'prod';

    const underProd = await DI.resolve(Orm);
    expect(underProd.Migrations.map((m) => m.name)).to.not.include('MigrationEnvTest_Decorated_2026_07_29_10_02_00');

    DI.clearCache();
    EnvConf.Env = 'local';

    const underLocal = await DI.resolve(Orm);
    expect(underLocal.Migrations.map((m) => m.name)).to.include('MigrationEnvTest_Decorated_2026_07_29_10_02_00');
  });

  it('refuses one class claimed by two different environments', async () => {
    EnvConf.Env = 'prod';
    FakeMigrationSource.Entries = [entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/src/MigrationEnvTest_Local_2026_07_29_10_01_00.local.js'), entry(MigrationEnvTest_Local_2026_07_29_10_01_00, '/app/lib/MigrationEnvTest_Local_2026_07_29_10_01_00.dev.js')];

    let err: unknown;
    try {
      await DI.resolve(Orm);
    } catch (e) {
      err = e;
    }

    expect(err, 'two environments for one migration were accepted').to.be.instanceOf(OrmException);
  });
});
