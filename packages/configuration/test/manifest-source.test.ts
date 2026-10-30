import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import glob from 'glob';
import _ from 'lodash';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { Container, DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { BaseFileSource, JsFileSource } from '../src/sources.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { ManifestConfigurationSource } from '../src/manifest-source.js';
import { effectiveManifestOf, manifestOf, manifestSettingsOf, registerManifestSettings } from '../src/manifest-runtime.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'manifest-app');
const PARITY = resolve(process.cwd(), 'test', 'fixtures', 'parity-app');
const readFixtureManifest = (): unknown => JSON.parse(readFileSync(join(PARITY, 'app.manifest.json'), 'utf8'));

async function boot(env: Record<string, string>, fileSources = true) {
  const container = DI.RootContainer.child({ isolateSingletons: true });
  container.register({ ...process.env, ...env }).asValue('process.env');
  container.register(ManifestConfigurationSource).as(ConfigurationSource);
  if (fileSources) container.register(JsFileSource).as(ConfigurationSource);
  container.register(FrameworkConfiguration).as(Configuration, { replace: true });
  const config = await container.resolve(Configuration);
  return { container, config };
}

// Everything a config file contributes: process.env is the environment and system.manifest the switch itself.
const write = (file: string, content: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

const loaded = (config: Configuration): unknown => JSON.parse(JSON.stringify(_.omit((config as FrameworkConfiguration).RootConfig, ['process', 'system.manifest'])));

describe('ManifestConfigurationSource', () => {
  let cwd: sinon.SinonStub;
  let ancestors: sinon.SinonSpy;
  let globSync: sinon.SinonSpy;
  let workspaceRoot: string | undefined;
  const open: IContainer[] = [];

  const start = async (env: Record<string, string>, fileSources = true) => {
    const booted = await boot(env, fileSources);
    open.push(booted.container);
    return booted;
  };

  const packageDirGlobs = () => globSync.getCalls().filter((c) => String(c.args[0]).includes('@spinajs/*'));

  beforeEach(() => {
    workspaceRoot = process.env.WORKSPACE_ROOT_PATH;
    delete process.env.WORKSPACE_ROOT_PATH;
    cwd = sinon.stub(process, 'cwd').returns(FIX);
    ancestors = sinon.spy(BaseFileSource as unknown as { nodeModulesAncestors: () => string[] }, 'nodeModulesAncestors');
    globSync = sinon.spy(glob, 'sync');
  });

  afterEach(async () => {
    sinon.restore();
    if (workspaceRoot === undefined) delete process.env.WORKSPACE_ROOT_PATH;
    else process.env.WORKSPACE_ROOT_PATH = workspaceRoot;
    for (const c of open.splice(0).reverse()) await c.dispose();
  });

  it('does nothing in off mode and leaves the node_modules walk in place', async () => {
    const { container, config } = await start({ SPINAJS_MANIFEST_MODE: 'off', APP_ENV: 'test' });
    expect(manifestOf(container)).to.equal(undefined);
    expect(ancestors.called).to.equal(true);
    expect(config.get('dep.loaded')).to.equal(true);
  });

  it('registers the manifest and takes the package config files from it', async () => {
    const { container, config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
    expect(manifestOf(container)?.app.name).to.equal('manifest-app');
    expect(config.get('sample.value')).to.equal('from-test-env');
    expect(config.get('dep.loaded')).to.equal(true);
    expect(packageDirGlobs(), 'no glob over the package config dirs').to.have.length(0);
    expect(process.env.WORKSPACE_ROOT_PATH).to.equal(FIX);
  });

  it('never walks node_modules with a manifest when WORKSPACE_ROOT_PATH is given', async () => {
    process.env.WORKSPACE_ROOT_PATH = FIX;
    const { config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
    expect(config.get('dep.loaded')).to.equal(true);
    expect(ancestors.called).to.equal(false);
  });

  it("loads the app's own config files once", async () => {
    const { config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
    expect(config.get<string[]>('sample.__file__').map((f) => f.replace(/\\/g, '/').split('/').pop())).to.deep.equal(['sample.js', 'sample.test.js']);
  });

  it('loads the plain defaults when no env sibling exists', async () => {
    const { config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'prod' });
    expect(config.get('sample.value')).to.equal('from-defaults');
  });

  it('require mode without a manifest fails the configuration', async () => {
    cwd.returns(resolve(FIX, 'empty'));
    await expect(start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' })).to.be.rejectedWith(/does not exist; run 'spinajs build'/);
  });

  it('rejects an unknown mode instead of turning the manifest off', async () => {
    await expect(start({ SPINAJS_MANIFEST_MODE: 'requre', APP_ENV: 'test' })).to.be.rejectedWith(/off, prefer, require/);
  });

  it('SPINAJS_MANIFEST overrides the path', async () => {
    cwd.returns(resolve(FIX, 'empty'));
    const { container } = await start({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: resolve(FIX, 'app.manifest.json'), APP_ENV: 'test' });
    expect(manifestOf(container)?.app.name).to.equal('manifest-app');
  });

  describe('package config files', () => {
    beforeEach(() => cwd.returns(PARITY));

    it('loads every package config file, also those no configuration module names', async () => {
      const { config } = await start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' });
      expect(packageDirGlobs()).to.have.length(0);
      expect(config.get('alpha')).to.deep.include({ value: 'app-override', overridden: 'beta', env: 'alpha-test' });
      expect(config.get('alphaExtra.loaded')).to.equal(true);
      expect(config.get('beta')).to.deep.include({ value: 'app-env-override', env: 'beta-test' });
      expect(config.get('app')).to.deep.include({ common: true, env: 'test' });
      // gamma's fragment predates configFiles: its one config dir is globbed
      expect(config.get('gamma.loaded')).to.equal(true);
    });

    it('merges to exactly the configuration the node_modules walk gives', async () => {
      const walk = loaded((await start({ SPINAJS_MANIFEST_MODE: 'off', APP_ENV: 'test' })).config);
      const listed = loaded((await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' })).config);
      expect(listed).to.deep.equal(walk);
      expect((walk as { system: { dirs: { cli: string[] } } }).system.dirs.cli.slice(0, 4)).to.deep.equal(['alpha-cli', 'beta-cli', 'app-cli', 'alpha-test-cli']);
    });

    for (const mode of ['off', 'prefer']) {
      it(`${mode} mode: an app array replaces the package default, package arrays and system.dirs compose`, async () => {
        const { config } = await start({ SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'test' });
        expect(config.get('alpha.transports')).to.deep.equal(['websocket']);
        expect(config.get('app.list')).to.deep.equal(['app-test']);
        expect(config.get('shared.packages')).to.deep.equal(['alpha', 'beta']);
        expect(config.get<string[]>('system.dirs.cli').slice(0, 4)).to.deep.equal(['alpha-cli', 'beta-cli', 'app-cli', 'alpha-test-cli']);
      });
    }
  });

  describe('the effective system.manifest', () => {
    it("is read from the app's own config files before any package config loads", async () => {
      const { container, config } = await start({ APP_ENV: 'test' });
      expect(manifestSettingsOf(container)).to.deep.equal({ mode: 'require', path: 'app.manifest.json' });
      expect(manifestOf(container)?.app.name).to.equal('manifest-app');
      expect(config.get('dep.loaded')).to.equal(true);
      expect(packageDirGlobs()).to.have.length(0);
      expect(config.get('system.manifest.mode')).to.equal('require');
    });

    it('takes SPINAJS_MANIFEST_MODE over the config files, in the final configuration too', async () => {
      const { container, config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
      expect(manifestSettingsOf(container)?.mode).to.equal('prefer');
      expect(config.get('system.manifest.mode')).to.equal('prefer');
    });

    it('turns the manifest off from the environment although a config file turns it on', async () => {
      const { container, config } = await start({ SPINAJS_MANIFEST_MODE: 'off', APP_ENV: 'test' });
      expect(manifestOf(container)).to.equal(undefined);
      expect(config.get('system.manifest.mode')).to.equal('off');
      expect(packageDirGlobs()).to.not.have.length(0);
    });

    it('is what effectiveManifestOf hands to the manifest consumers', async () => {
      const { container } = await start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' });
      const effective = effectiveManifestOf(container.child());
      expect(effective?.settings.mode).to.equal('require');
      expect(effective?.manifest?.app.name).to.equal('manifest-app');

      const undecided = new Container();
      open.push(undecided);
      expect(effectiveManifestOf(undecided)).to.equal(undefined);
      registerManifestSettings(undecided, { mode: 'require', path: 'app.manifest.json' });
      expect(() => effectiveManifestOf(undecided)).to.throw(/'require' but no manifest is registered/);
    });

    it("warns about unknown system.manifest keys in the app's config files", async () => {
      const warn = sinon.stub(InternalLogger, 'warn');
      await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'typo' });
      expect(warn.getCalls().some((c) => JSON.stringify(c.args).includes('modee'))).to.equal(true);
    });
  });

  describe('with packages installed at two node_modules levels', () => {
    let ws: string;

    const installPackage = (nodeModules: string, name: string, config: string) => {
      const root = join(nodeModules, '@spinajs', name);
      write(join(root, 'package.json'), { name: `@spinajs/${name}`, version: '0.0.0', type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } });
      write(join(root, 'lib', 'index.js'), 'export {};');
      write(join(root, 'lib', 'config', `${name}.js`), config);
      return { name: `@spinajs/${name}`, version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib', configFiles: [`config/${name}.js`] };
    };

    beforeEach(() => {
      ws = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-levels-ws-')));
      const app = join(ws, 'apps', 'app');
      write(join(ws, 'package.json'), { name: 'ws', private: true, workspaces: ['apps/*'] });
      write(join(app, 'package.json'), { name: 'app', version: '0.0.0', type: 'module' });
      // the walk merges the nearest level first, so the hoisted alpha overrides zeta although it sorts first by name
      const zeta = installPackage(join(app, 'node_modules'), 'zeta', "export default { shared: { by: 'zeta', zeta: true }, system: { dirs: { cli: ['zeta-cli'] } } };");
      const alpha = installPackage(join(ws, 'node_modules'), 'alpha', "export default { shared: { by: 'alpha', alpha: true }, system: { dirs: { cli: ['alpha-cli'] } } };");
      const manifest = JSON.parse(JSON.stringify(readFixtureManifest())) as Manifest;
      manifest.app = { name: 'app', version: '0.0.0', root: '/nonexistent/build-machine/app', outDir: 'lib' };
      manifest.packages = [alpha, zeta];
      manifest.hash = hashManifest(manifest);
      write(join(app, 'app.manifest.json'), manifest);
      cwd.returns(app);
    });

    afterEach(() => rmSync(ws, { recursive: true, force: true }));

    it('merges the package config files in the order of the walk: nearest level first, then by name', async () => {
      const walk = loaded((await start({ SPINAJS_MANIFEST_MODE: 'off', APP_ENV: 'test' })).config);
      const listed = loaded((await start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' })).config);
      const merged = walk as { shared: { by: string }; system: { dirs: { cli: string[] } } };
      expect(merged.shared.by).to.equal('alpha');
      expect(merged.system.dirs.cli.slice(0, 2)).to.deep.equal(['zeta-cli', 'alpha-cli']);
      expect(listed).to.deep.equal(walk);
    });
  });

  describe('with a listed package that is not installed', () => {
    let ws: string;
    let app: string;

    const entry = (name: string) => ({ name: `@spinajs/${name}`, version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib', configFiles: [`config/${name}.js`] });

    const install = (name: string) => {
      const root = join(app, 'node_modules', '@spinajs', name);
      write(join(root, 'package.json'), { name: `@spinajs/${name}`, version: '0.0.0', type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } });
      write(join(root, 'lib', 'index.js'), 'export {};');
      write(join(root, 'lib', 'config', `${name}.js`), `export default { ${name}: { loaded: true } };`);
    };

    const setup = (dependencies: Record<string, string>) => {
      write(join(app, 'package.json'), { name: 'app', version: '0.0.0', type: 'module', dependencies });
      install('present');
      const manifest = JSON.parse(JSON.stringify(readFixtureManifest())) as Manifest;
      manifest.app = { name: 'app', version: '0.0.0', root: '/nonexistent/build-machine/app', outDir: 'lib' };
      manifest.packages = [entry('absent'), entry('present')];
      manifest.hash = hashManifest(manifest);
      write(join(app, 'app.manifest.json'), manifest);
      cwd.returns(app);
    };

    beforeEach(() => {
      ws = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-absent-ws-')));
      app = join(ws, 'app');
    });

    afterEach(() => rmSync(ws, { recursive: true, force: true }));

    for (const mode of ['prefer', 'require']) {
      it(`${mode} mode skips an absent optional peer and merges what the walk merges`, async () => {
        setup({ '@spinajs/present': '0.0.0' });
        const walk = loaded((await start({ SPINAJS_MANIFEST_MODE: 'off', APP_ENV: 'test' })).config);
        const listed = loaded((await start({ SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'test' })).config);
        expect(listed).to.deep.equal(walk);
        expect((listed as { present: unknown }).present).to.deep.equal({ loaded: true, __file__: [join(app, 'node_modules', '@spinajs', 'present', 'lib', 'config', 'present.js')] });
        expect(listed).to.not.have.property('absent');
      });
    }

    it('require mode fails for a missing direct dependency of the app', async () => {
      setup({ '@spinajs/present': '0.0.0', '@spinajs/absent': '0.0.0' });
      await expect(start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' })).to.be.rejectedWith(/@spinajs\/absent.*not installed/);
    });

    it('prefer mode skips a missing direct dependency like the walk', async () => {
      setup({ '@spinajs/present': '0.0.0', '@spinajs/absent': '0.0.0' });
      const { config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
      expect(config.get('present.loaded')).to.equal(true);
    });
  });

  describe('in a linked workspace', () => {
    let ws: string;
    let app: string;

    beforeEach(() => {
      ws = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-linked-ws-')));
      app = join(ws, 'apps', 'app');
      const linked = join(ws, 'packages', 'linked');
      write(join(ws, 'package.json'), { name: 'ws', private: true, workspaces: ['apps/*', 'packages/*'] });
      write(join(linked, 'package.json'), { name: '@spinajs/linked', version: '0.0.0', type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } });
      write(join(linked, 'lib', 'index.js'), 'export {};');
      write(join(linked, 'lib', 'config', 'linked.js'), 'export default { linked: { root: process.env.WORKSPACE_ROOT_PATH ?? null } };');
      mkdirSync(join(ws, 'node_modules', '@spinajs'), { recursive: true });
      // a junction needs no elevation on Windows
      symlinkSync(linked, join(ws, 'node_modules', '@spinajs', 'linked'), 'junction');
      write(join(app, 'package.json'), { name: 'app', version: '0.0.0', type: 'module' });
      // the empty scope dir a workspace member keeps from linking; it must not be taken for the hoisting root
      mkdirSync(join(app, 'node_modules', '@spinajs'), { recursive: true });
      write(join(app, 'lib', 'config', 'app.js'), 'export const seenRoot = process.env.WORKSPACE_ROOT_PATH ?? null;\nexport default { app: { linked: true } };');
      const manifest = JSON.parse(JSON.stringify(readFixtureManifest())) as Manifest;
      manifest.app = { name: 'app', version: '0.0.0', root: '/nonexistent/build-machine/app', outDir: 'lib' };
      manifest.packages = [{ name: '@spinajs/linked', version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib', configFiles: ['config/linked.js'] }];
      manifest.hash = hashManifest(manifest);
      write(join(app, 'app.manifest.json'), manifest);
      cwd.returns(app);
    });

    afterEach(() => rmSync(ws, { recursive: true, force: true }));

    it('detects the hoisting root before the linked package config is imported', async () => {
      const { config } = await start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' });
      expect(config.get('linked.root')).to.equal(ws);
      expect(config.get('app.linked')).to.equal(true);
    });

    it('detects it before the app config files that decide the switch are read', async () => {
      await start({ SPINAJS_MANIFEST_MODE: 'require', APP_ENV: 'test' }, false);
      const module = (await import(pathToFileURL(join(app, 'lib', 'config', 'app.js')).href)) as { seenRoot: string | null };
      expect(module.seenRoot).to.equal(ws);
    });
  });
});
