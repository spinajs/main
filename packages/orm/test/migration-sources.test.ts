import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { DEFAULT_MIGRATION_DIRS, DiRegistryMigrationSource, FilesystemMigrationSource, MIGRATION_DI_SOURCE, Migration, OrmDriver, OrmException, OrmMigration } from '../src/index.js';
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

  it('falls back to the default directories when the configured value is empty, finding nothing while they are absent from disk', async () => {
    // an empty `system.dirs.migrations` no longer means "scan nothing" - it means "fall back to
    // DEFAULT_MIGRATION_DIRS". This asserts the negative half of that: if one of those defaults
    // happened to exist on disk ( a stray build, residue from another suite ) this would pass for
    // the wrong reason and any later failure here would point nowhere near the actual cause, so the
    // precondition is asserted explicitly rather than trusted
    DEFAULT_MIGRATION_DIRS.forEach((d) => {
      expect(fs.existsSync(d), `${d} exists on disk - this test needs every default migration directory absent to be meaningful`).to.equal(false);
    });

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

describe('FilesystemMigrationSource default directories', () => {
  // none of `DEFAULT_MIGRATION_DIRS` exist in this repo, which is exactly why this suite can
  // safely create and remove one of them ( `dist/migrations`, off this package's own cwd ) for the
  // lifetime of each test without touching anything a build or another suite depends on.
  const defaultDir = DEFAULT_MIGRATION_DIRS[2];

  function writeFallbackMigration(name: string): string {
    const importDir = path.relative(defaultDir, path.join(process.cwd(), 'src')).replace(/\\/g, '/');
    const file = path.join(defaultDir, `${name}.ts`);

    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(
      file,
      [`import { OrmDriver } from '${importDir}/driver.js';`, `import { OrmMigration } from '${importDir}/interfaces.js';`, '', `export class ${name} extends OrmMigration {`, '  public async up(_connection: OrmDriver): Promise<void> {}', '  public async down(_connection: OrmDriver): Promise<void> {}', '}', ''].join('\n'),
    );

    return file;
  }

  // removes `defaultDir` ( the `migrations` leaf ) and, if that leaves its parent ( `dist` ) empty,
  // removes the parent too - git cannot track an empty directory, so leaving it behind is residue
  // that `git status` will not show and a later `dist` build could mistake for its own output
  function cleanupDefaultDir(): void {
    fs.rmSync(defaultDir, { recursive: true, force: true });

    const parent = path.dirname(defaultDir);

    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }

  it('falls back to the exported defaults when the configured value is empty', async () => {
    writeFallbackMigration('DefaultDirsFallback_2026_07_29_10_03_00');

    try {
      MigrationSourcesConf.Dirs = [];
      const found = await discover();

      expect(found.map((f) => f.name)).to.include('DefaultDirsFallback_2026_07_29_10_03_00');
    } finally {
      cleanupDefaultDir();
      MigrationSourcesConf.Dirs = [FIXTURES];
    }
  });

  it('a configured directory replaces the defaults rather than adding to them', async () => {
    writeFallbackMigration('DefaultDirsReplaced_2026_07_29_10_04_00');

    try {
      MigrationSourcesConf.Dirs = [FIXTURES];
      const found = await discover();

      // the fixture placed at the default dir must not leak in on top of what was configured
      expect(found.map((f) => f.name)).to.not.include('DefaultDirsReplaced_2026_07_29_10_04_00');
      expect(found.map((f) => f.name)).to.include('Always_2026_07_29_10_00_00');
    } finally {
      cleanupDefaultDir();
      MigrationSourcesConf.Dirs = [FIXTURES];
    }
  });
});

describe('FilesystemMigrationSource import failures', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orm-migration-sources-'));
    MigrationSourcesConf.Dirs = [scratch];
  });

  afterEach(() => {
    sinon.restore();
    fs.rmSync(scratch, { recursive: true, force: true });
    MigrationSourcesConf.Dirs = [FIXTURES];
  });

  it('throws when a .js migration fails to import, naming the file', async () => {
    const brokenFile = path.join(scratch, 'BrokenJs_2026_07_29_10_05_00.js');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional js import failure');\n");

    let caught: unknown;

    try {
      await discover();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a broken .js migration must not be swallowed').to.be.instanceOf(OrmException);
    expect((caught as OrmException).message).to.contain(brokenFile);
    expect((caught as OrmException).inner).to.be.instanceOf(Error);
    expect(((caught as OrmException).inner as Error).message).to.contain('boom - intentional js import failure');
  });

  it('skips a .ts migration that fails to import, without throwing', async () => {
    const brokenFile = path.join(scratch, 'BrokenTs_2026_07_29_10_06_00.ts');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional ts import failure');\n");

    const found = await discover();

    expect(found).to.have.lengthOf(0);
  });

  it('logs a .ts import failure at trace, not warn', async () => {
    const brokenFile = path.join(scratch, 'BrokenTsLog_2026_07_29_10_07_00.ts');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional ts import failure for log level check');\n");

    // inlined rather than routed through discover(): a spy needs the resolved instance, which
    // discover() does not hand back - see its own comment for why clearCache() then
    // setESMModuleSupport() is the required order
    DI.clearCache();
    DI.setESMModuleSupport();
    const source = await DI.resolve(FilesystemMigrationSource);
    const trace = sinon.spy((source as any).Log, 'trace');
    const warn = sinon.spy((source as any).Log, 'warn');

    await source.getMigrations();

    expect(warn.called, 'a .ts import failure must not be logged at warn').to.equal(false);
    expect(trace.getCalls().some((c) => String(c.args[0]).includes(brokenFile)), 'expected the failure to be logged at trace, naming the file').to.equal(true);
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
