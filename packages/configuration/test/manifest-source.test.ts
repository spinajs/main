import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import glob from 'glob';
import { resolve } from 'node:path';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { BaseFileSource, JsFileSource } from '../src/sources.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { ManifestConfigurationSource, manifestOf } from '../src/manifest-source.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'manifest-app');

async function boot(env: Record<string, string>) {
  const container = DI.RootContainer.child({ isolateSingletons: true });
  container.register({ ...process.env, ...env }).asValue('process.env');
  container.register(ManifestConfigurationSource).as(ConfigurationSource);
  container.register(JsFileSource).as(ConfigurationSource);
  container.register(FrameworkConfiguration).as(Configuration, { replace: true });
  const config = await container.resolve(Configuration);
  return { container, config };
}

describe('ManifestConfigurationSource', () => {
  let cwd: sinon.SinonStub;
  let ancestors: sinon.SinonSpy;
  let globSync: sinon.SinonSpy;
  let workspaceRoot: string | undefined;
  const open: IContainer[] = [];

  const start = async (env: Record<string, string>) => {
    const booted = await boot(env);
    open.push(booted.container);
    return booted;
  };

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

  it('registers the manifest and loads only the listed defaults files', async () => {
    const { container, config } = await start({ SPINAJS_MANIFEST_MODE: 'prefer', APP_ENV: 'test' });
    expect(manifestOf(container)?.app.name).to.equal('manifest-app');
    expect(config.get('sample.value')).to.equal('from-test-env');
    expect(config.get('dep.loaded')).to.equal(true);
    expect(ancestors.called, 'node_modules walk must not run').to.equal(false);
    const packageGlobs = globSync.getCalls().filter((c) => String(c.args[0]).includes('node_modules/@spinajs'));
    expect(packageGlobs, 'no glob over package config dirs').to.have.length(0);
    expect(process.env.WORKSPACE_ROOT_PATH).to.equal(FIX);
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

  describe('reading system.manifest', () => {
    const configOf = (values: Record<string, unknown>) => ({ get: (path: string, def?: unknown) => (values[path] ?? def) }) as unknown as Configuration;
    const source = () => {
      const s = new ManifestConfigurationSource();
      (s as unknown as { Container: IContainer }).Container = DI.RootContainer.child({ isolateSingletons: true });
      return s;
    };

    it('lets SPINAJS_MANIFEST_MODE win over system.manifest.mode', async () => {
      const result = await source().Load(configOf({ 'system.manifest': { mode: 'require' }, 'system.manifest.mode': 'require', 'process.env.SPINAJS_MANIFEST_MODE': 'off' }));
      expect(result).to.deep.equal({});
    });

    it('warns about unknown system.manifest keys', async () => {
      const warn = sinon.stub(InternalLogger, 'warn');
      await source().Load(configOf({ 'system.manifest': { modee: 'require' } }));
      expect(warn.getCalls().some((c) => JSON.stringify(c.args).includes('modee'))).to.equal(true);
    });
  });
});
