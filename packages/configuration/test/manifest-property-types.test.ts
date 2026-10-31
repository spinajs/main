import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashManifest, type ClassPropertiesEntry, type Manifest, type ManifestMode, type RuntimeTypeRef } from '@spinajs/manifest';
import { Autoinject, DI, forgetPendingProperties, LazyInject, notePendingProperty, ResolveException, Singleton, type IContainer } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';
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
(Singleton() as ClassDecorator)(Repo);
(Autoinject() as PropertyDecorator)(Repo.prototype, 'db');

class LazyRepo {
  public db: Db;
}
LazyInject()(LazyRepo.prototype, 'db');

class Plugin {}

class Plugins {
  public list: Plugin[];
}
(Autoinject(Plugin) as PropertyDecorator)(Plugins.prototype, 'list');

// Every suite in this process boots: the classes above are declared for the tests that list them.
forgetPendingProperties();

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

  async function boot(manifest: Manifest, mode: ManifestMode, beforeConfiguration?: (container: IContainer) => void): Promise<IContainer> {
    const file = join(dir, `${open.length}.json`);
    writeFileSync(file, JSON.stringify(manifest));
    const container = DI.RootContainer.child({ isolateSingletons: true });
    open.push(container);
    container.register({ ...process.env, APP_ENV: 'test', SPINAJS_MANIFEST: file, SPINAJS_MANIFEST_MODE: mode }).asValue('process.env');
    container.register(ManifestConfigurationSource).as(ConfigurationSource);
    container.register(FrameworkConfiguration).as(Configuration, { replace: true });
    beforeConfiguration?.(container);
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

    it('injects one instance in prefer when the manifest does not list the property, with a named error', async () => {
      const error = sinon.stub(InternalLogger, 'error');
      try {
        const container = await boot(manifestOf({}), 'prefer');
        container.register(Plugin).asSelf();
        expect(container.resolve(Plugins).list).to.be.instanceOf(Plugin);
        expect(error.getCalls().map((c) => (c.args[0] as { property: string }).property)).to.deep.equal(['Plugins.list']);
      } finally {
        error.restore();
      }
    });
  });

  describe('a build that does not match the manifest', () => {
    class Late {
      public dep: Db;
    }
    class Many {
      public list: Plugin[];
    }

    beforeEach(() => {
      (Autoinject() as PropertyDecorator)(Late.prototype, 'dep');
      (Autoinject(Plugin) as PropertyDecorator)(Many.prototype, 'list');
    });

    afterEach(() => {
      forgetPendingProperties();
    });

    it('fails a require boot listing every pair the table lacks', async () => {
      await expect(boot(manifestOf({}), 'require')).to.be.rejectedWith(ResolveException, /does not list Late\.dep, Many\.list; rebuild it/);
    });

    it('lists only what the table lacks', async () => {
      await expect(boot(manifestOf({ classProperties: [entry('Many', 'list', undefined, undefined, true)] }), 'require')).to.be.rejectedWith(/does not list Late\.dep;/);
    });

    it('passes a require boot when the table lists them', async () => {
      await boot(manifestOf({ classProperties: [entry('Late', 'dep', DB), entry('Many', 'list', undefined, undefined, true)] }), 'require');
    });

    it('logs a named error for each in prefer, once, and boots', async () => {
      const error = sinon.stub(InternalLogger, 'error');
      try {
        await boot(manifestOf({}), 'prefer');
        expect(error.getCalls().map((c) => (c.args[0] as { property: string }).property)).to.deep.equal(['Late.dep', 'Many.list']);
      } finally {
        error.restore();
      }
    });

    it('stays out of the way in off mode', async () => {
      await boot(manifestOf({}), 'off');
    });
  });

  describe('a property nothing can type', () => {
    class Bare {
      public dep: Db;
    }
    class NoRef {
      public when: Date;
    }
    class Named {
      public dep: Db;
    }
    class Dep {}

    const table = [entry('Bare', 'dep'), entry('NoRef', 'when'), entry('Named', 'dep')];

    before(() => {
      (Autoinject() as PropertyDecorator)(Bare.prototype, 'dep');
      (Autoinject() as PropertyDecorator)(NoRef.prototype, 'when');
      (Autoinject(Dep) as PropertyDecorator)(Named.prototype, 'dep');
    });

    beforeEach(() => {
      notePendingProperty(Bare, 'dep');
      notePendingProperty(NoRef, 'when');
      notePendingProperty(Named, 'dep', Dep);
    });

    afterEach(() => {
      forgetPendingProperties();
    });

    it('fails a require boot, not the first resolve: a row is not a type', async () => {
      await expect(boot(manifestOf({ classProperties: table }), 'require')).to.be.rejectedWith(ResolveException, /Bare\.dep, NoRef\.when; pass the type to the decorator/);
    });

    it('logs a named error for each in prefer, once, and boots', async () => {
      const error = sinon.stub(InternalLogger, 'error');
      try {
        await boot(manifestOf({ classProperties: table }), 'prefer');
        expect(error.getCalls().map((c) => (c.args[0] as { property: string }).property)).to.deep.equal(['Bare.dep', 'NoRef.when']);
      } finally {
        error.restore();
      }
    });

    it('passes a require boot when the table has the type', async () => {
      await boot(manifestOf({ classProperties: [entry('Bare', 'dep', DB), entry('NoRef', 'when', DB), entry('Named', 'dep')] }), 'require');
    });
  });

  describe('@Autoinject(X) resolved before Configuration', () => {
    class Early {
      public list: Plugin[];
    }
    class EarlyLazy {
      public list: Plugin[];
    }
    class EarlyOne {
      public one: Plugin;
    }

    const table = [entry('Early', 'list', undefined, undefined, true), entry('EarlyLazy', 'list', undefined, undefined, true), entry('EarlyOne', 'one')];
    const resolveEarly = (container: IContainer) => {
      container.register(Plugin).asSelf();
      container.resolve(Early);
      container.resolve(EarlyLazy);
      container.resolve(EarlyOne);
    };

    before(() => {
      (Autoinject(Plugin) as PropertyDecorator)(Early.prototype, 'list');
      (LazyInject(Plugin) as PropertyDecorator)(EarlyLazy.prototype, 'list');
      (Autoinject(Plugin) as PropertyDecorator)(EarlyOne.prototype, 'one');
    });

    beforeEach(() => {
      notePendingProperty(Early, 'list', Plugin);
      notePendingProperty(EarlyLazy, 'list', Plugin);
      notePendingProperty(EarlyOne, 'one', Plugin);
    });

    afterEach(() => {
      forgetPendingProperties();
    });

    it('fails a require boot naming every list that got one instance', async () => {
      await expect(boot(manifestOf({ classProperties: table }), 'require', resolveEarly)).to.be.rejectedWith(ResolveException, /Early\.list, EarlyLazy\.list .*before Configuration/);
    });

    it('logs a named error for each in prefer, once, and boots', async () => {
      const error = sinon.stub(InternalLogger, 'error');
      try {
        const container = await boot(manifestOf({ classProperties: table }), 'prefer', resolveEarly);
        expect(container.resolve(Early).list).to.be.instanceOf(Plugin);
        expect(error.getCalls().map((c) => (c.args[0] as { property: string }).property)).to.deep.equal(['Early.list', 'EarlyLazy.list']);
      } finally {
        error.restore();
      }
    });

    it('passes a require boot when the property is a single class', async () => {
      const container = await boot(manifestOf({ classProperties: table }), 'require', (c) => {
        c.register(Plugin).asSelf();
        c.resolve(EarlyOne);
      });
      expect(container.resolve(EarlyOne).one).to.be.instanceOf(Plugin);
    });

    it('injects the list when Configuration comes first', async () => {
      const container = await boot(manifestOf({ classProperties: table }), 'require');
      container.register(Plugin).asSelf();
      expect(container.resolve(Early).list).to.be.an('array').with.length(1);
    });
  });
});
