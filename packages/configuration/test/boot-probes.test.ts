import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';
import { JsFileSource, JsonFileSource } from '../src/sources.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { ManifestConfigurationSource } from '../src/manifest-source.js';

const PARITY = resolve(process.cwd(), 'test', 'fixtures', 'parity-app');
const PROBES = ['existsSync', 'realpathSync'] as const;
type Probe = (typeof PROBES)[number];

const nodeFs = createRequire(import.meta.url)('node:fs') as Record<Probe, (...args: unknown[]) => unknown>;

async function fsCallsOf(run: () => Promise<unknown>): Promise<Record<Probe, string[]>> {
  const calls = Object.fromEntries(PROBES.map((p) => [p, [] as string[]])) as Record<Probe, string[]>;
  const originals = PROBES.map((p) => [p, nodeFs[p]] as const);
  for (const [name, original] of originals) {
    nodeFs[name] = Object.assign((...args: unknown[]) => {
      calls[name].push(String(args[0]).replace(/\\/g, '/'));
      return original(...args);
    }, original);
  }
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const [name, original] of originals) nodeFs[name] = original;
    syncBuiltinESMExports();
  }
  return calls;
}

describe('configuration boot from a manifest', () => {
  let workspaceRoot: string | undefined;
  const open: IContainer[] = [];

  const boot = async (mode: string) => {
    const container = DI.RootContainer.child({ isolateSingletons: true });
    open.push(container);
    container.register({ ...process.env, SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'test' }).asValue('process.env');
    container.register(ManifestConfigurationSource).as(ConfigurationSource);
    container.register(JsFileSource).as(ConfigurationSource);
    container.register(JsonFileSource).as(ConfigurationSource);
    container.register(FrameworkConfiguration).as(Configuration, { replace: true });
    return container.resolve(Configuration);
  };

  beforeEach(() => {
    workspaceRoot = process.env.WORKSPACE_ROOT_PATH;
    process.env.WORKSPACE_ROOT_PATH = PARITY;
    sinon.stub(process, 'cwd').returns(PARITY);
  });

  afterEach(async () => {
    sinon.restore();
    if (workspaceRoot === undefined) delete process.env.WORKSPACE_ROOT_PATH;
    else process.env.WORKSPACE_ROOT_PATH = workspaceRoot;
    for (const c of open.splice(0).reverse()) await c.dispose();
  });

  it("lists the app's own config dirs without glob: only a fragment without configFiles is globbed", async () => {
    const globSync = sinon.spy(glob, 'sync');
    const config = await boot('require');
    expect(config.get('alpha.value')).to.equal('app-override');
    expect(globSync.getCalls().map((c) => c.args[1]?.cwd?.replace(/\\/g, '/'))).to.deep.equal(Array(4).fill(`${PARITY.replace(/\\/g, '/')}/node_modules/@spinajs/gamma/lib/config`));
  });

  it('probes each package install level once', async () => {
    const calls = await fsCallsOf(() => boot('require'));
    const levels = calls.existsSync.filter((p) => /node_modules\/@spinajs\/[^/]+$/.test(p));
    expect(levels.length).to.be.greaterThan(0);
    expect(new Set(levels).size).to.equal(levels.length);
  });

  it('takes the real path of each config dir once, not of every config file', async () => {
    const calls = await fsCallsOf(() => boot('require'));
    expect(calls.realpathSync.filter((p) => /\.(c?js|json)$/.test(p))).to.deep.equal([]);
  });

  it('loads what the off mode walk loads', async () => {
    const strip = (c: Configuration) => JSON.parse(JSON.stringify((c as FrameworkConfiguration).RootConfig, (k, v: unknown) => (k === 'process' || k === 'manifest' ? undefined : v))) as unknown;
    const walked = strip(await boot('off'));
    expect(strip(await boot('require'))).to.deep.equal(walked);
    expect(strip(await boot('prefer'))).to.deep.equal(walked);
  });
});
