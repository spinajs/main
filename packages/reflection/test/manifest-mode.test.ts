import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import glob from 'glob';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IContainer } from '@spinajs/di';
import { FrameworkConfiguration, ManifestConfigurationSource, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { createTestApp, disposeTestApps, testManifest, sourceRef, withManifest } from '@spinajs/testing';
import { ManifestMissing } from '@spinajs/manifest';
import { ListFromFiles, listFromManifest, ResolveFromFiles } from '../src/index.js';
import { FooService } from './test-services/singletons/FooService.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const root = process.cwd();
const singletons = join(root, 'test', 'test-services', 'singletons');

type Listed = Array<{ file: string; name: string; type: unknown; instance: unknown }>;

// The decorator caches its result per class, so every test gets a class of its own.
function listerOf(options: { manifest: 'commands' } | undefined = { manifest: 'commands' }) {
  class Lister {
    @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.singletons', undefined, options)
    public Items!: Promise<Listed>;
  }
  return Lister;
}

function resolverOf() {
  class Resolver {
    @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.singletons', undefined, { manifest: 'commands' })
    public Items!: Promise<Listed>;
  }
  return Resolver;
}

const manifest = testManifest({
  root,
  commands: [{ name: 'foo', className: 'FooService', options: [], arguments: [], source: sourceRef('test/test-services/singletons/FooService.ts') }],
});

const config = { system: { dirs: { singletons: [singletons] } } };

/** A Configuration whose only source is the manifest source, so the switch comes from the environment or the config dirs. */
class ManifestSourceConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [this.Container.resolve(ManifestConfigurationSource)];
  }

  protected onLoad(): unknown {
    return config;
  }
}

const withEnv = (env: Record<string, string>) => (c: IContainer) => c.register({ ...process.env, ...env }).asValue('process.env');

describe('ListFromFiles manifest fast path', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  it('lists manifest entries without globbing in prefer mode', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config, register: withManifest(manifest, 'prefer') });
    const items = await app.container.resolve(listerOf()).Items;
    expect(items.map((i) => i.name)).to.deep.equal(['FooService']);
    expect(items[0].type).to.equal(FooService);
    expect(items[0].file).to.equal(resolve(singletons, 'FooService.js'));
    expect(globSync.called).to.equal(false);
  });

  it('listFromManifest drops entries rejected by include before importing their file', async () => {
    const other = { name: 'bar', className: 'BarService', options: [], arguments: [], source: sourceRef('test/test-services/singletons/NoSuchFile.ts') };
    const app = await createTestApp({ config, register: withManifest(testManifest({ root, commands: [...manifest.commands, other] }), 'require') });
    const listed = await listFromManifest(app.container, 'commands', 'require', (entry) => entry.className !== 'BarService');
    expect(listed?.map((i) => i.name)).to.deep.equal(['FooService']);
  });

  it('resolves instances for ResolveFromFiles', async () => {
    const app = await createTestApp({ config, register: withManifest(manifest) });
    const items = await app.container.resolve(resolverOf()).Items;
    expect(items[0].instance).to.be.instanceOf(FooService);
  });

  it('scans when mode is off', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config, register: withManifest(manifest, 'off') });
    await app.container.resolve(listerOf()).Items;
    expect(globSync.called).to.equal(true);
  });

  it('scans when only the system.manifest config key asks for the manifest', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({
      config: { system: { ...config.system, manifest: { mode: 'require' } } },
      register: (c) => registerManifest(c, manifest),
    });
    await app.container.resolve(listerOf()).Items;
    expect(globSync.called).to.equal(true);
  });

  it('maps system.dirs.cli to the commands section, but not for a lister with a typeMatcher', async () => {
    class Mapped {
      @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
      public Items!: Promise<Listed>;
    }
    class Matched {
      @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli', (_file, exportName) => exportName)
      public Items!: Promise<Listed>;
    }
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config: { system: { dirs: { cli: [singletons] } } }, register: withManifest(manifest) });
    expect((await app.container.resolve(Mapped).Items).map((i) => i.name)).to.deep.equal(['FooService']);
    expect(globSync.called).to.equal(false);
    await app.container.resolve(Matched).Items;
    expect(globSync.called).to.equal(true);
  });

  it('prefer mode without a manifest scans', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const app = await createTestApp({ config, register: (c) => registerManifestSettings(c, { mode: 'prefer', path: 'app.manifest.json' }) });
    await app.container.resolve(listerOf()).Items;
    expect(globSync.called).to.equal(true);
  });

  it('require mode without a manifest throws ManifestMissing', async () => {
    const app = await createTestApp({ config, register: (c) => registerManifestSettings(c, { mode: 'require', path: 'app.manifest.json' }) });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /commands/);
  });

  it('fails when a listed class is not exported by its file', async () => {
    const bad = testManifest({
      root,
      commands: [{ name: 'x', className: 'Nope', options: [], arguments: [], source: sourceRef('test/test-services/singletons/FooService.ts') }],
    });
    const app = await createTestApp({ config, register: withManifest(bad, 'require') });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /does not export class Nope/);
  });

  it('refuses an entry whose source leaves the package root', async () => {
    const escaping = testManifest({
      root,
      commands: [{ name: 'x', className: 'FooService', options: [], arguments: [], source: sourceRef('../../outside/FooService.ts') }],
    });
    const app = await createTestApp({ config, register: withManifest(escaping, 'require') });
    await expect(app.container.resolve(listerOf()).Items).to.be.rejectedWith(ManifestMissing, /leaves the root/);
  });

  it('skips the entries of a listed package that is not installed', async () => {
    const absent = '@spinajs/absent-peer';
    const withAbsent = testManifest({
      root,
      packages: [{ name: absent, version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib' }],
      commands: [
        ...manifest.commands,
        { name: 'gone', className: 'Gone', options: [], arguments: [], source: { file: 'src/cli/Gone.ts', line: 1, col: 1, package: absent } },
      ],
    });
    for (const mode of ['prefer', 'require'] as const) {
      const app = await createTestApp({ config, register: withManifest(withAbsent, mode) });
      const items = await app.container.resolve(listerOf()).Items;
      expect(items.map((i) => i.name)).to.deep.equal(['FooService']);
      await disposeTestApps();
    }
  });

  describe('with the switch decided by ManifestConfigurationSource', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'spinajs-reflection-manifest-'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'manifest-switch', type: 'module' }));
      writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify(manifest));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('uses the manifest when the environment turns it on', async () => {
      const globSync = sinon.spy(glob, 'sync');
      const app = await createTestApp({
        configuration: ManifestSourceConfiguration,
        register: withEnv({ SPINAJS_MANIFEST_MODE: 'prefer', SPINAJS_MANIFEST: join(dir, 'app.manifest.json') }),
      });
      const items = await app.container.resolve(listerOf()).Items;
      expect(items.map((i) => i.name)).to.deep.equal(['FooService']);
      expect(globSync.getCalls().filter((c) => String(c.args[0]).includes('singletons'))).to.have.length(0);
    });

    it('uses the manifest in require mode from a config file and never throws ManifestMissing', async () => {
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', 'manifest.js'), "export default { system: { manifest: { mode: 'require' } } };");
      const cwd = sinon.stub(process, 'cwd').returns(dir);
      const app = await createTestApp({ configuration: ManifestSourceConfiguration, register: withEnv({}) }).finally(() => cwd.restore());
      expect(app.config.get('system.manifest.mode')).to.equal('require');
      const items = await app.container.resolve(listerOf()).Items;
      expect(items.map((i) => i.name)).to.deep.equal(['FooService']);
    });
  });
});
