import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as path from 'node:path';
import { DiRegistryMigrationSource, FilesystemMigrationSource, MIGRATION_DI_SOURCE, Migration, OrmDriver, OrmMigration } from '../src/index.js';
import { ConnectionConf, registerFakes } from './misc.js';
import '@spinajs/log';

const expect = chai.expect;

const FIXTURES = path.resolve(path.join(process.cwd(), 'test', 'mocks', 'migration-env'));

const sideEffects = ((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []);

/** Configuration whose only job is to point `system.dirs.migrations` at the fixture directory. */
class MigrationSourcesConf extends ConnectionConf {
  public static Env = 'prod';
  public static Dirs: string[] = [FIXTURES];

  public async resolve(): Promise<void> {
    await super.resolve();

    this.set('system.dirs.migrations', MigrationSourcesConf.Dirs);
    this.set('process.env.APP_ENV', MigrationSourcesConf.Env);
  }
}

@Migration('sqlite', { Env: 'local' })
class MigrationSourcesTest_Registered_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

async function discover(): Promise<Array<ClassInfo<OrmMigration>>> {
  DI.clearCache();
  // `FilesystemMigrationSource` loads fixture files via `DI.__spinajs_require__`, which falls back
  // to CJS `require` unless ESM mode is switched on ( the same setup every other file-discovery
  // suite in the repo does - schema-providers.test.ts, http's controllers.test.ts... ). `asValue`
  // registrations live in the container CACHE, so the `clearCache()` above wipes this out on every
  // call and it must be re-applied after, not once in `before()`.
  DI.setESMModuleSupport();
  return await (await DI.resolve(FilesystemMigrationSource)).getMigrations();
}

describe('FilesystemMigrationSource under prod', () => {
  let found: Array<ClassInfo<OrmMigration>>;

  before(async () => {
    registerFakes();
    DI.register(MigrationSourcesConf).as(Configuration);

    MigrationSourcesConf.Env = 'prod';
    MigrationSourcesConf.Dirs = [FIXTURES];
    found = await discover();
  });

  it('finds the unsuffixed migration', () => {
    expect(found.map((f) => f.name)).to.include('Always_2026_07_29_10_00_00');
  });

  it('reports the file it came from', () => {
    const always = found.find((f) => f.name === 'Always_2026_07_29_10_00_00');

    expect(always!.file.replace(/\\/g, '/')).to.contain('mocks/migration-env/Always_2026_07_29_10_00_00.ts');
  });

  it('does not find migrations belonging to other environments', () => {
    expect(found.map((f) => f.name)).to.not.include('OnlyLocal_2026_07_29_10_01_00');
    expect(found.map((f) => f.name)).to.not.include('OnlyDev_2026_07_29_10_02_00');
  });

  it('never IMPORTS a migration from another environment', () => {
    // importing fires @Migration, which would register the class no matter what filter ran after
    expect(sideEffects, 'a foreign-environment migration was executed by the mere act of discovery').to.not.include('OnlyLocal_2026_07_29_10_01_00.local.ts');
    expect(sideEffects).to.not.include('OnlyDev_2026_07_29_10_02_00.dev.ts');
    // the matching one was executed, so the absence above is a filter and not a broken fixture
    expect(sideEffects).to.include('Always_2026_07_29_10_00_00.ts');
  });

  it('returns nothing when no directory is configured', async () => {
    MigrationSourcesConf.Dirs = [];

    expect(await discover()).to.have.lengthOf(0);

    MigrationSourcesConf.Dirs = [FIXTURES];
  });

  it('survives a directory that does not exist', async () => {
    MigrationSourcesConf.Dirs = [path.join(FIXTURES, 'no-such-dir')];

    expect(await discover()).to.have.lengthOf(0);

    MigrationSourcesConf.Dirs = [FIXTURES];
  });
});

describe('FilesystemMigrationSource under local', () => {
  let found: Array<ClassInfo<OrmMigration>>;

  before(async () => {
    MigrationSourcesConf.Env = 'local';
    found = await discover();
  });

  after(() => {
    MigrationSourcesConf.Env = 'prod';
  });

  it('finds this environment\'s migration alongside the unsuffixed one', () => {
    expect(found.map((f) => f.name)).to.include('OnlyLocal_2026_07_29_10_01_00');
    expect(found.map((f) => f.name)).to.include('Always_2026_07_29_10_00_00');
  });

  it('still excludes another environment\'s', () => {
    expect(found.map((f) => f.name)).to.not.include('OnlyDev_2026_07_29_10_02_00');
  });
});

describe('DiRegistryMigrationSource', () => {
  after(() => {
    DI.unregister(MigrationSourcesTest_Registered_2026_07_29_10_00_00);
  });

  it('yields DI-registered migrations with the file the decorator captured', async () => {
    DI.clearCache();
    const found = await (await DI.resolve(DiRegistryMigrationSource)).getMigrations();
    const entry = found.find((f) => f.name === 'MigrationSourcesTest_Registered_2026_07_29_10_00_00');

    expect(entry, 'the DI registry source did not report a decorated migration').to.not.equal(undefined);
    expect(entry!.file.replace(/\\/g, '/')).to.contain('test/migration-sources.test.ts');
    expect(entry!.file).to.not.equal(MIGRATION_DI_SOURCE);
  });
});
