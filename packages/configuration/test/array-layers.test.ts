import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, StaticConfigurationSource } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { ManifestConfigurationSource } from '../src/manifest-source.js';
import { JsFileSource, JsonFileSource } from '../src/sources.js';

const PARITY = resolve(process.cwd(), 'test', 'fixtures', 'parity-app');

const write = (file: string, content: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

const cjs = (value: unknown) => `module.exports = ${JSON.stringify(value)};`;

describe('config file layers', () => {
  const open: IContainer[] = [];
  let root: string;
  let app: string;
  let workspaceRoot: string | undefined;

  function installPackage(name: string, files: Record<string, unknown>) {
    const dir = join(app, 'node_modules', '@spinajs', name);
    write(join(dir, 'package.json'), { name: `@spinajs/${name}`, version: '0.0.0', exports: { '.': './lib/index.js', './package.json': './package.json' } });
    write(join(dir, 'lib', 'index.js'), 'module.exports = {};');
    for (const [file, content] of Object.entries(files)) write(join(dir, 'lib', 'config', file), content);
    return { name: `@spinajs/${name}`, version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib', configFiles: Object.keys(files).map((f) => `config/${f}`) };
  }

  function writeManifest(packages: Manifest['packages']) {
    const manifest = JSON.parse(readFileSync(join(PARITY, 'app.manifest.json'), 'utf8')) as Manifest;
    manifest.app = { name: 'app', version: '0.0.0', root: '/nonexistent/build-machine/app', outDir: 'lib' };
    manifest.packages = packages;
    manifest.hash = hashManifest(manifest);
    write(join(app, 'app.manifest.json'), manifest);
  }

  async function boot(mode: string, setup: (c: IContainer) => void = () => undefined) {
    const container = DI.RootContainer.child({ isolateSingletons: true });
    open.push(container);
    container.register({ ...process.env, SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'test' }).asValue('process.env');
    container.register(ManifestConfigurationSource).as(ConfigurationSource);
    container.register(JsFileSource).as(ConfigurationSource);
    container.register(JsonFileSource).as(ConfigurationSource);
    setup(container);
    container.register(FrameworkConfiguration).as(Configuration, { replace: true });
    return container.resolve<Configuration>(Configuration);
  }

  beforeEach(() => {
    workspaceRoot = process.env.WORKSPACE_ROOT_PATH;
    delete process.env.WORKSPACE_ROOT_PATH;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-layers-')));
    app = join(root, 'app');
    write(join(app, 'package.json'), { name: 'app', version: '0.0.0' });
    sinon.stub(process, 'cwd').returns(app);
  });

  afterEach(async () => {
    sinon.restore();
    if (workspaceRoot === undefined) delete process.env.WORKSPACE_ROOT_PATH;
    else process.env.WORKSPACE_ROOT_PATH = workspaceRoot;
    for (const c of open.splice(0).reverse()) await c.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  for (const mode of ['off', 'prefer']) {
    describe(`in ${mode} mode`, () => {
      const packages = (...list: ReturnType<typeof installPackage>[]) => writeManifest(list);

      it('a package JSON adds to the arrays of a package JS file', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pa'] } }) }), installPackage('pb', { 'pb.json': { kv: { list: ['pb-json'] } } }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['pa', 'pb-json']);
      });

      it('a package JSON stays below an app JS file, for arrays and scalars', async () => {
        packages(installPackage('pa', { 'pa.json': { kv: { list: ['pkg-json'], value: 'pkg-json' } } }));
        write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app-js'], value: 'app-js' } }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['app-js']);
        expect(config.get('kv.value')).to.equal('app-js');
      });

      it('an app JSON file still wins over an app JS file', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] } }) }));
        write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app-js'], value: 'app-js' } }));
        write(join(app, 'lib', 'config', 'app.json'), { kv: { list: ['app-json'], value: 'app-json' } });
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['app-json']);
        expect(config.get('kv.value')).to.equal('app-json');
      });

      it('src/config sits above the packages, for arrays and scalars', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'], value: 'pkg' } }) }));
        write(join(app, 'src', 'config', 'app.cjs'), cjs({ kv: { list: ['app-src'], value: 'app-src' } }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['app-src']);
        expect(config.get('kv.value')).to.equal('app-src');
      });

      it('a package env file stays below an app common file, for arrays and scalars', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] } }), 'pa.test.cjs': cjs({ kv: { list: ['pkg-env'], value: 'pkg-env' } }) }));
        write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app'], value: 'app' } }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['app']);
        expect(config.get('kv.value')).to.equal('app');
      });

      it('a package env file adds to the arrays of package common files', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] } }), 'pa.test.cjs': cjs({ kv: { list: ['pkg-env'] } }) }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['pkg', 'pkg-env']);
      });

      it('an app env file replaces its common file and a composed array keeps every layer', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] }, system: { dirs: { cli: ['pkg-cli'] } } }), 'pa.test.cjs': cjs({ system: { dirs: { cli: ['pkg-env-cli'] } } }) }));
        write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app'] }, system: { dirs: { cli: ['app-cli'] } } }));
        write(join(app, 'lib', 'config', 'app.test.cjs'), cjs({ kv: { list: ['app-env'] }, system: { dirs: { cli: ['app-env-cli'] } } }));
        const config = await boot(mode);
        expect(config.get('kv.list')).to.deep.equal(['app-env']);
        expect(config.get<string[]>('system.dirs.cli').slice(0, 4)).to.deep.equal(['pkg-cli', 'pkg-env-cli', 'app-cli', 'app-env-cli']);
      });

      // Source results merge by Order, and the file sources (Order 1) hold the package defaults.
      it('a StaticConfigurationSource at its default Order loses a value array to the package default', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] }, system: { dirs: { cli: ['pkg-cli'] } } }) }));
        const config = await boot(mode, (c) => c.register(StaticConfigurationSource({ kv: { list: ['static'] }, system: { dirs: { cli: ['static-cli'] } } })).as(ConfigurationSource));
        expect(config.get('kv.list')).to.deep.equal(['pkg']);
        expect(config.get<string[]>('system.dirs.cli')).to.include.members(['static-cli', 'pkg-cli']);
      });

      it('a StaticConfigurationSource after the file sources replaces the app array', async () => {
        packages(installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] } }) }));
        write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app'] } }));
        const config = await boot(mode, (c) => c.register(StaticConfigurationSource({ kv: { list: ['static'] } }, 2)).as(ConfigurationSource));
        expect(config.get('kv.list')).to.deep.equal(['static']);
      });
    });
  }

  it('Load() of a file source gives its own layers merged, for mergeSource()', async () => {
    installPackage('pa', { 'pa.cjs': cjs({ kv: { list: ['pkg'] } }) });
    write(join(app, 'lib', 'config', 'app.cjs'), cjs({ kv: { list: ['app'] } }));
    const container = DI.RootContainer.child({ isolateSingletons: true });
    open.push(container);
    container.register({ ...process.env, APP_ENV: 'test' }).asValue('process.env');
    container.register(StaticConfigurationSource({})).as(ConfigurationSource);
    container.register(FrameworkConfiguration).as(Configuration, { replace: true });
    const config = (await container.resolve(Configuration)) as FrameworkConfiguration;
    await config.mergeSource(JsFileSource);
    expect(config.get('kv.list')).to.deep.equal(['app']);
  });
});
