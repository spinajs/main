import { Configuration } from '@spinajs/configuration';
import { ClassInfo, DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { currentBuildMigrationDir, DEFAULT_MIGRATION_DIRS, DiRegistryMigrationSource, FilesystemMigrationSource, MIGRATION_DI_SOURCE, Migration, OrmDriver, OrmException, OrmMigration } from '../src/index.js';
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
    [...DEFAULT_MIGRATION_DIRS, currentBuildMigrationDir()].forEach((d) => {
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

  it('refuses an APP_ENV that is not a plain identifier rather than silently building a broken glob', async () => {
    MigrationSourcesConf.Env = 'weird!name';

    let caught: unknown;

    try {
      await discover();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'an APP_ENV carrying glob metacharacters must not silently scan nothing').to.be.instanceOf(OrmException);
    expect((caught as OrmException).message).to.contain('weird!name');

    MigrationSourcesConf.Env = 'prod';
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

/**
 * `build/migrations` and bare `migrations` joined `src/lib/dist` in `DEFAULT_MIGRATION_DIRS`
 * because every package in this repo actually compiles to `lib/cjs` and `lib/mjs` - there is no
 * bare `lib/migrations` anywhere spinajs itself produces, which made the old three-entry fallback
 * a silent no-op for a deployment built the spinajs way.
 *
 * `lib/cjs/migrations` and `lib/mjs/migrations` are deliberately NOT static entries here - they
 * are the SAME source compiled twice, and scanning both unconditionally is exactly what broke
 * `packages/queue` ( a `.js` under `lib/cjs` parses as ESM, since every package here ships
 * `"type": "module"` with no `package.json` written into `lib/cjs`, and fails to import ). Only
 * the one matching the current runtime is ever scanned, via `currentBuildMigrationDir()` - see
 * its own doc comment and the "never scans the other module format" suite below.
 *
 * The membership checks below are deliberately NOT a filesystem round-trip through
 * `build/migrations` for `lib/cjs`/`lib/mjs` themselves: those two are this very package's OWN
 * real compile output directories, and once `npm run compile` / `compile:cjs` has run, each carries
 * its own `package.json` ( `{ "type": "commonjs" }` / `{ "type": "module" }`, written by
 * `scripts/generate-packages-for-modules.mjs` ) - a boundary a dynamically-imported `.ts` FIXTURE
 * placed there sits right under, which made this suite flake ( a `.ts` import failure is tolerated
 * silently, so the failure mode is an empty result, not an error ). The fallback-scan MECHANISM
 * itself - that every entry in `DEFAULT_MIGRATION_DIRS` is actually scanned, not just the first
 * three - is already proven generically by the unmodified `dist/migrations` round-trip above, which
 * exercises the exact same loop `build/migrations` and `currentBuildMigrationDir()` go through.
 * `build/migrations` below is round-tripped for that same generic reason, in a location `tsc`
 * never writes to.
 */
describe('FilesystemMigrationSource default directories - build, bare migrations', () => {
  const buildDir = DEFAULT_MIGRATION_DIRS.find((d) => d.replace(/\\/g, '/').endsWith('/build/migrations'));
  const bareDir = DEFAULT_MIGRATION_DIRS.find((d) => d.replace(/\\/g, '/').match(/(^|\/)migrations$/) && !d.replace(/\\/g, '/').match(/(src|lib|dist|build)\/migrations$/));

  it('no longer carries lib/cjs/migrations or lib/mjs/migrations as static entries', () => {
    expect(DEFAULT_MIGRATION_DIRS.some((d) => d.replace(/\\/g, '/').endsWith('lib/cjs/migrations')), 'DEFAULT_MIGRATION_DIRS must not carry a static lib/cjs/migrations entry - only the runtime-selected one is scanned').to.equal(false);
    expect(DEFAULT_MIGRATION_DIRS.some((d) => d.replace(/\\/g, '/').endsWith('lib/mjs/migrations')), 'DEFAULT_MIGRATION_DIRS must not carry a static lib/mjs/migrations entry - only the runtime-selected one is scanned').to.equal(false);
  });

  it('carries build/migrations and bare migrations', () => {
    expect(buildDir, 'DEFAULT_MIGRATION_DIRS no longer carries a build/migrations entry').to.be.a('string');
    expect(bareDir, 'DEFAULT_MIGRATION_DIRS no longer carries a bare migrations entry').to.be.a('string');
  });

  function writeFallbackMigration(dir: string, name: string): void {
    const importDir = path.relative(dir, path.join(process.cwd(), 'src')).replace(/\\/g, '/');
    const file = path.join(dir, `${name}.ts`);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      [`import { OrmDriver } from '${importDir}/driver.js';`, `import { OrmMigration } from '${importDir}/interfaces.js';`, '', `export class ${name} extends OrmMigration {`, '  public async up(_connection: OrmDriver): Promise<void> {}', '  public async down(_connection: OrmDriver): Promise<void> {}', '}', ''].join('\n'),
    );
  }

  // `build/`, unlike `lib/cjs` and `lib/mjs`, is never a real compile output directory in this
  // repo - free of the package.json-boundary trap described above, so a plain filesystem
  // round-trip is safe here.
  function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });

    const parent = path.dirname(dir);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }

  it('falls back to build/migrations when the configured value is empty', async () => {
    writeFallbackMigration(buildDir!, 'DefaultDirsBuildFallback_2026_07_29_10_08_00');

    try {
      MigrationSourcesConf.Dirs = [];
      const found = await discover();

      expect(found.map((f) => f.name)).to.include('DefaultDirsBuildFallback_2026_07_29_10_08_00');
    } finally {
      cleanup(buildDir!);
      MigrationSourcesConf.Dirs = [FIXTURES];
    }
  });
});

describe('currentBuildMigrationDir', () => {
  it('resolves to lib/mjs/migrations when the __esmMode__ DI flag is set', () => {
    DI.clearCache();
    DI.setESMModuleSupport();

    expect(currentBuildMigrationDir().replace(/\\/g, '/')).to.match(/\/lib\/mjs\/migrations$/);
  });

  it('resolves to lib/cjs/migrations when the __esmMode__ DI flag was never set', () => {
    // no setESMModuleSupport() call after this clearCache() - the flag lives in the container
    // cache ( see discover()'s own comment ), so this leaves it unregistered, exactly the state a
    // consumer that never opted into ESM mode is in
    DI.clearCache();

    expect(currentBuildMigrationDir().replace(/\\/g, '/')).to.match(/\/lib\/cjs\/migrations$/);
  });
});

/**
 * The regression this whole change fixes: `DEFAULT_MIGRATION_DIRS` briefly carried BOTH
 * `lib/cjs/migrations` and `lib/mjs/migrations` unconditionally - the same compiled source twice,
 * only one of which any given runtime can load. A package that ships both builds ( every package
 * in this repo ) then has a `.js` sibling under whichever format the runtime is NOT using, and
 * that sibling fails to import for a reason that has nothing to do with the migration itself -
 * Node parses `lib/cjs/*.js` as ESM because no package carries a `package.json` there declaring
 * otherwise. `packages/queue`'s test suite hit exactly this: `DI.resolve(Orm)` died in
 * `discoverMigrations()` trying to import its own `lib/cjs/migrations` output.
 *
 * `discover()` always calls `DI.setESMModuleSupport()`, so this file's own runtime format is
 * always mjs - making `lib/cjs/migrations` the "other" format for every test in this suite. A
 * `.js` file planted there that throws unconditionally on import proves two things at once: it is
 * never scanned ( absent from the result ) and `getMigrations()` does not throw reaching it -
 * which only means something because the file WOULD throw if it were ever imported, per the
 * `.js`-failure-throws rule this change does not weaken.
 */
describe('FilesystemMigrationSource never scans the other module format\'s build dir', () => {
  const otherFormatDir = path.resolve(path.normalize(path.join(process.cwd(), 'lib', 'cjs', 'migrations')));

  afterEach(() => {
    fs.rmSync(otherFormatDir, { recursive: true, force: true });

    const parent = path.dirname(otherFormatDir);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }

    MigrationSourcesConf.Dirs = [FIXTURES];
  });

  it('never imports a poison file under lib/cjs/migrations while running under ESM mode, and does not throw', async () => {
    fs.mkdirSync(otherFormatDir, { recursive: true });
    fs.writeFileSync(path.join(otherFormatDir, 'Poison_2026_07_29_10_11_00.js'), "throw new Error('boom - this file belongs to the other module format and must never be imported');\n");

    MigrationSourcesConf.Dirs = [];

    const found = await discover();

    expect(found.map((f) => f.name), 'a file under the OTHER format\'s build dir must never be scanned, let alone imported').to.not.include('Poison_2026_07_29_10_11_00');
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

  it('throws when a .js migration in a CONFIGURED directory fails to import, naming the file', async () => {
    // `scratch` is set on `MigrationSourcesConf.Dirs` in this suite's `beforeEach` above, i.e.
    // `system.dirs.migrations` is non-empty - a CONFIGURED directory, not a fallback one. That
    // distinction is exactly what now decides throw-vs-warn, so it is spelled out here rather than
    // left implicit.
    const brokenFile = path.join(scratch, 'BrokenJs_2026_07_29_10_05_00.js');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional js import failure');\n");

    let caught: unknown;

    try {
      await discover();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a broken .js migration in a configured directory must not be swallowed').to.be.instanceOf(OrmException);
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

  it('matches .cjs files at all - a broken one throws, naming the file', async () => {
    // before the extension list grew to include cjs/mjs, this file was never even MATCHED by the
    // glob, so `discover()` returned [] with no error at all - the throw below is the proof the
    // scan now reaches it in the first place, not merely that a broken file is handled once found
    const brokenFile = path.join(scratch, 'BrokenCjs_2026_07_29_10_09_00.cjs');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional cjs import failure');\n");

    let caught: unknown;

    try {
      await discover();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a .cjs file must be matched by the scan and its failure surfaced').to.be.instanceOf(OrmException);
    expect((caught as OrmException).message).to.contain(brokenFile);
  });

  it('matches .mjs files at all - a broken one throws, naming the file', async () => {
    const brokenFile = path.join(scratch, 'BrokenMjs_2026_07_29_10_10_00.mjs');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional mjs import failure');\n");

    let caught: unknown;

    try {
      await discover();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a .mjs file must be matched by the scan and its failure surfaced').to.be.instanceOf(OrmException);
    expect((caught as OrmException).message).to.contain(brokenFile);
  });
});

/**
 * The decision this suite locks in: an import failure in a directory the OPERATOR named
 * (`system.dirs.migrations` configured, covered above) still throws - but the same failure in a
 * directory WE guessed (`DEFAULT_MIGRATION_DIRS`) only warns and is skipped. Nobody asked for that
 * directory to be scanned, so a broken file sitting in it is not this ORM's business to kill a
 * boot over.
 */
describe('FilesystemMigrationSource import failures - fallback directory', () => {
  // `lib/migrations` ( `DEFAULT_MIGRATION_DIRS[1]` ), not `dist` or `build` - both of those are
  // already round-tripped by the "default directories" suites above, and sharing one here would
  // make cross-suite cleanup ordering load-bearing for no reason. Like `dist` and `build`, `lib`
  // alone is never a real compile output directory in this repo - that is `lib/cjs` / `lib/mjs`,
  // see the doc comment on `DEFAULT_MIGRATION_DIRS` - so a plain filesystem round-trip is safe.
  const fallbackDir = DEFAULT_MIGRATION_DIRS[1];

  function writeGoodMigration(name: string): void {
    const importDir = path.relative(fallbackDir, path.join(process.cwd(), 'src')).replace(/\\/g, '/');

    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackDir, `${name}.ts`),
      [`import { OrmDriver } from '${importDir}/driver.js';`, `import { OrmMigration } from '${importDir}/interfaces.js';`, '', `export class ${name} extends OrmMigration {`, '  public async up(_connection: OrmDriver): Promise<void> {}', '  public async down(_connection: OrmDriver): Promise<void> {}', '}', ''].join('\n'),
    );
  }

  function cleanup(): void {
    fs.rmSync(fallbackDir, { recursive: true, force: true });

    const parent = path.dirname(fallbackDir);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }

  afterEach(() => {
    sinon.restore();
    cleanup();
    MigrationSourcesConf.Dirs = [FIXTURES];
  });

  it('warns and skips a broken .js migration, and still returns the good migrations found alongside it', async () => {
    fs.mkdirSync(fallbackDir, { recursive: true });

    const brokenFile = path.join(fallbackDir, 'BrokenFallbackJs_2026_07_29_10_12_00.js');
    fs.writeFileSync(brokenFile, "throw new Error('boom - intentional js import failure in a fallback directory');\n");
    writeGoodMigration('GoodFallback_2026_07_29_10_13_00');

    // an empty configured value is what selects the fallback dirs - see `getMigrations()`'s own
    // comment on `isConfigured`
    MigrationSourcesConf.Dirs = [];

    // inlined rather than routed through discover(): a spy needs the resolved instance, same as
    // the .ts trace-vs-warn test above
    DI.clearCache();
    DI.setESMModuleSupport();
    const source = await DI.resolve(FilesystemMigrationSource);
    const warn = sinon.spy((source as any).Log, 'warn');

    let found: Array<ClassInfo<OrmMigration>> | undefined;
    let caught: unknown;

    try {
      found = await source.getMigrations();
    } catch (err) {
      caught = err;
    }

    expect(caught, 'a broken .js migration in a FALLBACK directory must not throw').to.equal(undefined);

    expect(warn.called, 'the failure must be logged at warn').to.equal(true);
    const call = warn.getCalls().find((c) => String(c.args[1]).includes(brokenFile));
    expect(call, 'the warning must name the file').to.not.equal(undefined);
    expect(call!.args[0], 'the warning must carry the original error so the stack survives').to.be.instanceOf(Error);
    expect(String(call!.args[1]), 'the warning must say the migration was not registered').to.match(/not registered/i);

    // one bad file must not have voided the rest of the scan
    expect(found!.map((f) => f.name), 'the good migration alongside the skipped one must still be reported').to.include('GoodFallback_2026_07_29_10_13_00');
  });
});

/**
 * Before the harvest was gated on `MIGRATION_FILE_REGEXP`, a class extending `OrmMigration` whose
 * name carried no timestamp was reported like any other migration - and later crashed the boot in
 * `Orm.registerMigration()`, which throws `OrmException` for a name it cannot order. That failure
 * named the FILE this source reported - a shared abstract base class an app never meant to
 * register, or (worse) the barrel that merely re-exported one from somewhere else entirely.
 */
describe('FilesystemMigrationSource skips non-migration classes', () => {
  // parented under this package's OWN `test/mocks`, not `os.tmpdir()` - so the relative import of
  // `src/driver.js` / `src/interfaces.js` the fixtures below need stays a short, reliable path
  // instead of crossing from a system temp directory back into the repository.
  const scratchRoot = path.join(process.cwd(), 'test', 'mocks');

  it('skips a class with no timestamp in its name, living directly in a scanned directory', async () => {
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'harvest-base-'));
    const importDir = path.relative(scratch, path.join(process.cwd(), 'src')).replace(/\\/g, '/');

    try {
      fs.writeFileSync(
        path.join(scratch, 'BaseSeedMigration.ts'),
        [`import { OrmDriver } from '${importDir}/driver.js';`, `import { OrmMigration } from '${importDir}/interfaces.js';`, '', 'export abstract class BaseSeedMigration extends OrmMigration {', '  public async up(_connection: OrmDriver): Promise<void> {}', '  public async down(_connection: OrmDriver): Promise<void> {}', '}', ''].join('\n'),
      );

      MigrationSourcesConf.Dirs = [scratch];
      const found = await discover();

      expect(found.map((f) => f.name), 'a class carrying no timestamp must never be reported as a migration').to.not.include('BaseSeedMigration');
    } finally {
      MigrationSourcesConf.Dirs = [FIXTURES];
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('skips a migration base class re-exported from a barrel file outside the scanned directory', async () => {
    const root = fs.mkdtempSync(path.join(scratchRoot, 'harvest-barrel-'));
    const scanned = path.join(root, 'migrations');
    const shared = path.join(root, 'shared');

    fs.mkdirSync(scanned, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });

    const importDir = path.relative(shared, path.join(process.cwd(), 'src')).replace(/\\/g, '/');

    try {
      // lives OUTSIDE the scanned directory - the scan never reaches it directly, only through
      // the barrel's re-export below, exactly the shape a package's shared base class takes
      fs.writeFileSync(
        path.join(shared, 'BaseSeedMigration.ts'),
        [`import { OrmDriver } from '${importDir}/driver.js';`, `import { OrmMigration } from '${importDir}/interfaces.js';`, '', 'export class BaseSeedMigration extends OrmMigration {', '  public async up(_connection: OrmDriver): Promise<void> {}', '  public async down(_connection: OrmDriver): Promise<void> {}', '}', ''].join('\n'),
      );

      // dotless, so it matches the unsuffixed glob just like any other migration file would
      fs.writeFileSync(path.join(scanned, 'index.ts'), "export * from '../shared/BaseSeedMigration.js';\n");

      MigrationSourcesConf.Dirs = [scanned];
      const found = await discover();

      expect(found.map((f) => f.name), 'a barrel re-exporting a non-migration base class must not report it - under the barrel file or otherwise').to.not.include('BaseSeedMigration');
    } finally {
      MigrationSourcesConf.Dirs = [FIXTURES];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DiRegistryMigrationSource', () => {
  after(() => {
    DI.unregister(MigrationSourcesTest_Registered_2026_07_29_10_00_00);

    // `MigrationSourcesConf` was registered as `Configuration` in the very first `before()` in
    // this file and never unregistered - this is the LAST describe this file defines, so this is
    // where that registration stops leaking `system.dirs.migrations` and `process.env.APP_ENV`
    // into whatever test file a full-glob mocha run moves on to next. `migration-env.test.ts`
    // does this cleanup properly; this matches it.
    DI.unregister(MigrationSourcesConf);
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
