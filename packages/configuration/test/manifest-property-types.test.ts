import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashManifest, type ClassPropertiesEntry, type Manifest, type ManifestMode, type RuntimeTypeRef } from '@spinajs/manifest';
import { Autoinject, DI, LazyInject, ResolveException, Singleton, type IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';
import { FrameworkConfiguration } from '../src/configuration.js';
import { ManifestConfigurationSource } from '../src/manifest-source.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ROOT = resolve(process.cwd(), 'test', 'fixtures', 'property-types');
const source = { file: 'src/x.ts', line: 1, col: 1, package: 'property-types' };
const DB: RuntimeTypeRef = { package: 'property-types', file: 'src/db.ts', export: 'Db' };
const BROKEN: RuntimeTypeRef = { package: 'property-types', file: 'src/broken.ts', export: 'Broken' };

interface Db {
  kind: string;
}

// Applied by hand: TypeScript emits `design:type` only for decorators it applies itself, so these have no metadata.
class Repo {
  public db: Db;

  public find() {
    return this.db.kind;
  }
}
Singleton()(Repo);
Autoinject()(Repo.prototype, 'db');

class LazyRepo {
  public db: Db;
}
LazyInject()(LazyRepo.prototype, 'db');

class Plugin {}

class Plugins {
  public list: Plugin[];
}
Autoinject(Plugin)(Plugins.prototype, 'list');

const entry = (className: string, property: string, tokenRef?: RuntimeTypeRef, id = `property-types:${className}`, array = false): ClassPropertiesEntry => ({
  id,
  className,
  properties: [{ property, token: 'x', optional: false, array, ...(tokenRef ? { tokenRef } : {}) }],
  source,
});

const serviceOf = (className: string, tokenRef: RuntimeTypeRef) => ({
  id: `property-types:${className}`,
  className,
  registeredAs: [className],
  lifetime: 'singleton' as const,
  async: false,
  bootstrapper: false,
  ctorInjects: [],
  propertyInjects: [{ property: 'db', token: 'Db', optional: false, array: false, tokenRef }],
  source,
});

function manifestOf(overrides: Partial<Manifest>): Manifest {
  const manifest: Manifest = {
    manifestVersion: 2,
    app: { name: 'property-types', version: '0.0.0', root: ROOT, outDir: 'out' },
    packages: [],
    generatedAt: '2026-10-30T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: {},
    diagnostics: [],
    ...overrides,
  };
  return { ...manifest, hash: hashManifest(manifest) };
}

const dbLoads = (): number | undefined => (globalThis as { __propertyTypesDbLoaded?: number }).__propertyTypesDbLoaded;

describe('property types from the manifest', () => {
  let dir: string;
  const open: IContainer[] = [];

  async function boot(manifest: Manifest, mode: ManifestMode): Promise<IContainer> {
    const file = join(dir, `${open.length}.json`);
    writeFileSync(file, JSON.stringify(manifest));
    const container = DI.RootContainer.child({ isolateSingletons: true });
    open.push(container);
    container.register({ ...process.env, APP_ENV: 'test', SPINAJS_MANIFEST: file, SPINAJS_MANIFEST_MODE: mode }).asValue('process.env');
    container.register(ManifestConfigurationSource).as(ConfigurationSource);
    container.register(FrameworkConfiguration).as(Configuration, { replace: true });
    await container.resolve(Configuration);
    return container;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'property-types-'));
  });

  afterEach(async () => {
    for (const c of open.splice(0).reverse()) await c.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the first resolve of a sync service sync: DI.resolve(Repo).find()', async () => {
    const container = await boot(manifestOf({ services: [serviceOf('Repo', DB)], classProperties: [entry('Repo', 'db', DB)] }), 'require');
    expect(container.resolve(Repo).find()).to.equal('db');
  });

  it('answers a @LazyInject() read in sync on the first read', async () => {
    const container = await boot(manifestOf({ services: [serviceOf('LazyRepo', DB)], classProperties: [entry('LazyRepo', 'db', DB)] }), 'prefer');
    expect(container.resolve(LazyRepo).db.kind).to.equal('db');
  });

  it('imports nothing for a manifest without the table: a build with decorator metadata stays as it was', async () => {
    const before = dbLoads();
    await boot(manifestOf({ services: [serviceOf('Repo', { ...DB, file: 'src/db.ts?never' })] }), 'require');
    expect(dbLoads()).to.equal(before);
  });

  it('fails the boot in require when a class cannot load, naming the entry and the property', async () => {
    await expect(boot(manifestOf({ classProperties: [entry('Repo', 'db', BROKEN)] }), 'require')).to.be.rejectedWith(/property-types:Repo\.db/);
  });

  it('leaves the failure to the owner in prefer', async () => {
    const container = await boot(manifestOf({ classProperties: [entry('Repo', 'db', BROKEN)] }), 'prefer');
    expect(() => container.resolve(Repo)).to.throw(ResolveException, /Repo\.db/);
  });

  describe('two classes with one name', () => {
    it('throws instead of picking one when they declare the property differently', async () => {
      const container = await boot(manifestOf({ classProperties: [entry('Repo', 'db', DB), entry('Repo', 'db', undefined, 'other:Repo')] }), 'prefer');
      expect(() => container.resolve(Repo)).to.throw(ResolveException, /more than one class Repo/);
    });

    it('answers when they declare it alike', async () => {
      const container = await boot(manifestOf({ classProperties: [entry('Repo', 'db', DB), entry('Repo', 'db', DB, 'other:Repo')] }), 'prefer');
      expect(container.resolve(Repo).find()).to.equal('db');
    });
  });

  describe('@Autoinject(X) on a list', () => {
    it('injects the list the manifest records', async () => {
      const container = await boot(manifestOf({ classProperties: [entry('Plugins', 'list', undefined, undefined, true)] }), 'require');
      container.register(Plugin).asSelf();
      expect(container.resolve(Plugins).list).to.be.an('array').with.length(1);
    });

    it('fails in require when the manifest does not list the property', async () => {
      const container = await boot(manifestOf({}), 'require');
      expect(() => container.resolve(Plugins)).to.throw(ResolveException, /Plugins\.list/);
    });
  });
});
