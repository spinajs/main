import { Class, ClassInfo } from '@spinajs/di';
import { ManifestMissing } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';
import { createTestApp, sourceRef, testManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { expect } from 'chai';
import glob from 'glob';
import 'mocha';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sinon from 'sinon';
import { FilesystemMigrationSource, ManifestMigrationSource, OrmMigration } from '../src/index.js';
import { ConnectionConf, ormApp } from './misc.js';
import '@spinajs/log';

const FIXTURES = resolve(process.cwd(), 'test', 'mocks', 'migration-env');
const sideEffects = ((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []);

class ManifestSourceConf extends ConnectionConf {
  public static Env = 'prod';

  public async resolve(): Promise<void> {
    await super.resolve();

    this.set('system.dirs.migrations', [FIXTURES]);
    this.set('process.env.APP_ENV', ManifestSourceConf.Env);
  }
}

const entry = (className: string, file: string) => ({
  id: `test-app:${className}`,
  className,
  connection: 'sqlite',
  file,
  source: sourceRef(`test/mocks/migration-env/${file}`),
});

// what the compiler lists for the fixture directory: every environment's migration, alphabetically
const manifest = (): Manifest =>
  testManifest({
    root: process.cwd(),
    migrations: [
      entry('Always_2026_07_29_10_00_00', 'Always_2026_07_29_10_00_00.ts'),
      entry('OnlyDev_2026_07_29_10_02_00', 'OnlyDev_2026_07_29_10_02_00.dev.ts'),
      entry('OnlyLocal_2026_07_29_10_01_00', 'OnlyLocal_2026_07_29_10_01_00.local.ts'),
    ],
  });

const ENV_KEYS = ['SPINAJS_MANIFEST_MODE', 'SPINAJS_MANIFEST'] as const;

describe('ManifestMigrationSource', function () {
  this.timeout(30000);

  let app: TestApp | undefined;
  let restoreEnv: (() => void) | undefined;
  let tmp: string | undefined;

  // The mode is decided before any config file loads, so a test turns it on the way a deployed app does: through the environment
  async function boot(mode: string | undefined, env = 'prod', m: Manifest = manifest()): Promise<TestApp> {
    ManifestSourceConf.Env = env;
    if (mode) {
      tmp = mkdtempSync(join(tmpdir(), 'spinajs-manifest-'));
      const file = join(tmp, 'app.manifest.json');
      writeFileSync(file, JSON.stringify(m));
      const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
      process.env.SPINAJS_MANIFEST_MODE = mode;
      process.env.SPINAJS_MANIFEST = file;
      restoreEnv = () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }
    app = await createTestApp(ormApp({ configuration: ManifestSourceConf }));
    return app;
  }

  const view = (found: Array<ClassInfo<OrmMigration>>) => found.map((f) => ({ name: f.name, file: f.file.replace(/\.[mc]?[jt]s$/, '') }));

  afterEach(async () => {
    sinon.restore();
    await app?.dispose();
    app = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    ManifestSourceConf.Env = 'prod';
  });

  it('lists the manifest migrations and does not glob in require mode', async () => {
    const booted = await boot('require');
    const globSync = sinon.spy(glob, 'sync');

    const found = await (await booted.resolve(ManifestMigrationSource)).getMigrations();

    expect(found.map((f) => f.name)).to.deep.equal(['Always_2026_07_29_10_00_00']);
    expect((found[0].type as Class<OrmMigration>).prototype).to.be.instanceOf(OrmMigration);
    expect(await (await booted.resolve(FilesystemMigrationSource)).getMigrations()).to.deep.equal([]);
    expect(globSync.called).to.equal(false);
  });

  // modules are cached, so this only sees imports that happen here: it is meaningful when the file runs on its own
  it('never imports a migration file suffixed for another environment', async () => {
    const before = sideEffects.length;
    const booted = await boot('require', 'prod');
    await (await booted.resolve(ManifestMigrationSource)).getMigrations();

    const imported = sideEffects.slice(before);
    expect(imported).to.not.include('OnlyLocal_2026_07_29_10_01_00.local.ts');
    expect(imported).to.not.include('OnlyDev_2026_07_29_10_02_00.dev.ts');
  });

  for (const env of ['prod', 'local', 'dev']) {
    it(`parity: manifest mode lists exactly the migrations the directory scan finds under ${env}, in the same order`, async () => {
      const scanning = await boot(undefined, env);
      const scanned = view(await (await scanning.resolve(FilesystemMigrationSource)).getMigrations());
      await scanning.dispose();
      app = undefined;

      const booted = await boot('require', env);
      const listed = view(await (await booted.resolve(ManifestMigrationSource)).getMigrations());

      expect(scanned.length).to.be.greaterThan(0);
      expect(listed).to.deep.equal(scanned);
    });
  }

  it('is empty in off mode and the filesystem source still scans', async () => {
    const booted = await boot('off');

    expect(await (await booted.resolve(ManifestMigrationSource)).getMigrations()).to.deep.equal([]);
    expect((await (await booted.resolve(FilesystemMigrationSource)).getMigrations()).length).to.be.greaterThan(0);
  });

  it('is empty when no manifest is registered', async () => {
    const booted = await boot(undefined);
    expect(await (await booted.resolve(ManifestMigrationSource)).getMigrations()).to.deep.equal([]);
  });

  it('skips migrations of a listed package that is not installed', async () => {
    const ghost = { ...entry('Ghost_2026_07_29_10_09_00', 'Ghost_2026_07_29_10_09_00.ts'), source: sourceRef('src/migrations/Ghost_2026_07_29_10_09_00.ts', '@ghost/not-installed') };
    const m = testManifest({
      root: process.cwd(),
      migrations: [entry('Always_2026_07_29_10_00_00', 'Always_2026_07_29_10_00_00.ts'), ghost],
      packages: [{ name: '@ghost/not-installed', version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: 'lib/manifest.fragment.json' }],
    });
    const booted = await boot('prefer', 'prod', m);

    const found = await (await booted.resolve(ManifestMigrationSource)).getMigrations();
    expect(found.map((f) => f.name)).to.deep.equal(['Always_2026_07_29_10_00_00']);
  });

  it('fails when a listed class is not exported by its file', async () => {
    const m = testManifest({ root: process.cwd(), migrations: [entry('Missing_2026_07_29_10_00_00', 'Always_2026_07_29_10_00_00.ts')] });
    const booted = await boot('require', 'prod', m);

    let error: unknown;
    try {
      await (await booted.resolve(ManifestMigrationSource)).getMigrations();
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(ManifestMissing);
  });
});
