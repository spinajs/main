import { Class, ClassInfo, DI } from '@spinajs/di';
import { ManifestMissing } from '@spinajs/manifest';
import type { Manifest, ManifestMode } from '@spinajs/manifest';
import { createTestApp, sourceRef, testManifest, withManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { expect } from 'chai';
import glob from 'glob';
import 'mocha';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sinon from 'sinon';
import { FilesystemMigrationSource, ManifestMigrationSource, OrmMigration } from '../src/index.js';
import { ConnectionConf, ormApp } from './misc.js';
import '@spinajs/log';

// Its own directory, so what the other migration tests import never changes what these cases see.
const FIXTURES = resolve(process.cwd(), 'test', 'mocks', 'migration-manifest');

class ManifestSourceConf extends ConnectionConf {
  public static Env = 'prod';

  public async resolve(): Promise<void> {
    await super.resolve();

    this.set('system.dirs.migrations', [FIXTURES]);
    this.set('process.env.APP_ENV', ManifestSourceConf.Env);
  }
}

const entry = (file: string) => {
  const className = basename(file).replace(/\.(local|dev)?\.?ts$/, '');
  return { id: `test-app:${className}`, className, connection: 'sqlite', file, source: sourceRef(`test/mocks/migration-manifest/${file}`) };
};

// what the compiler lists for the fixture directory: every environment's migration, sorted by code unit
const COMPILER_ORDER = [
  'Alpha_2026_08_01_10_00_00.ts',
  'Beta_2026_08_01_10_01_00.local.ts',
  'Epsilon_2026_08_01_10_04_00.dev.ts',
  'Gamma_2026_08_01_10_02_00.ts',
  'delta_2026_08_01_10_03_00.ts',
];

const manifest = (files: string[] = COMPILER_ORDER): Manifest => testManifest({ root: process.cwd(), migrations: files.map(entry) });

describe('ManifestMigrationSource', function () {
  this.timeout(30000);

  let app: TestApp | undefined;

  const imported: string[] = [];

  async function boot(mode: ManifestMode | undefined, env = 'prod', m: Manifest = manifest()): Promise<TestApp> {
    ManifestSourceConf.Env = env;
    app = await createTestApp(
      ormApp({
        configuration: ManifestSourceConf,
        register: (c) => {
          c.register({
            load: async (file: string) => {
              imported.push(basename(file).replace(/.[mc]?[jt]s$/, ''));
              const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
              return loaded.default ?? loaded;
            },
          }).asValue(DI.MODULE_LOADER.key);
          if (mode) withManifest(m, mode)(c);
        },
      }),
    );
    return app;
  }

  const view = (found: Array<ClassInfo<OrmMigration>>) => found.map((f) => ({ name: f.name, file: f.file.replace(/\.[mc]?[jt]s$/, '') }));

  afterEach(async () => {
    sinon.restore();
    await app?.dispose();
    app = undefined;
    imported.length = 0;
    ManifestSourceConf.Env = 'prod';
  });

  it('lists the manifest migrations and does not glob in require mode', async () => {
    const booted = await boot('require');
    const globSync = sinon.spy(glob, 'sync');

    const found = await (await booted.resolve(ManifestMigrationSource)).getMigrations();

    expect(found.map((f) => f.name)).to.deep.equal(['Alpha_2026_08_01_10_00_00', 'delta_2026_08_01_10_03_00', 'Gamma_2026_08_01_10_02_00']);
    expect((found[0].type as Class<OrmMigration>).prototype).to.be.instanceOf(OrmMigration);
    expect(await (await booted.resolve(FilesystemMigrationSource)).getMigrations()).to.deep.equal([]);
    expect(globSync.called).to.equal(false);
  });

  it('never imports a migration file suffixed for another environment', async () => {
    const booted = await boot('require', 'prod');

    await (await booted.resolve(ManifestMigrationSource)).getMigrations();

    expect(imported).to.include('Alpha_2026_08_01_10_00_00');
    expect(imported).to.not.include('Beta_2026_08_01_10_01_00.local');
    expect(imported).to.not.include('Epsilon_2026_08_01_10_04_00.dev');
  });

  for (const env of ['prod', 'local', 'dev']) {
    it(`parity: lists the migrations the directory scan finds under ${env}, in the same order, from a manifest in compiler order`, async () => {
      const scanning = await boot(undefined, env);
      const scanned = view(await (await scanning.resolve(FilesystemMigrationSource)).getMigrations());
      await scanning.dispose();
      app = undefined;

      const booted = await boot('require', env);
      const listed = view(await (await booted.resolve(ManifestMigrationSource)).getMigrations());

      expect(scanned.length).to.be.greaterThan(2);
      expect(listed).to.deep.equal(scanned);
    });
  }

  it('lists unsuffixed files before the environment suffixed ones, each in locale order', async () => {
    const booted = await boot('require', 'local');

    const found = await (await booted.resolve(ManifestMigrationSource)).getMigrations();
    expect(found.map((f) => f.name)).to.deep.equal(['Alpha_2026_08_01_10_00_00', 'delta_2026_08_01_10_03_00', 'Gamma_2026_08_01_10_02_00', 'Beta_2026_08_01_10_01_00']);
  });

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
    const ghost = { ...entry('Ghost_2026_08_01_10_09_00.ts'), source: sourceRef('src/migrations/Ghost_2026_08_01_10_09_00.ts', '@ghost/not-installed') };
    const m = testManifest({
      root: process.cwd(),
      migrations: [entry('Alpha_2026_08_01_10_00_00.ts'), ghost],
      packages: [{ name: '@ghost/not-installed', version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: 'lib/manifest.fragment.json' }],
    });
    const booted = await boot('prefer', 'prod', m);

    const found = await (await booted.resolve(ManifestMigrationSource)).getMigrations();
    expect(found.map((f) => f.name)).to.deep.equal(['Alpha_2026_08_01_10_00_00']);
  });

  it('fails when a listed class is not exported by its file', async () => {
    const m = testManifest({ root: process.cwd(), migrations: [{ ...entry('Alpha_2026_08_01_10_00_00.ts'), className: 'Missing_2026_08_01_10_00_00' }] });
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
