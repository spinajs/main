import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { join } from 'node:path';
import { createTestApp, disposeTestApps, sourceRef, testManifest, withManifest } from '@spinajs/testing';
import '@spinajs/log';
import { Cli } from '../src/index.js';

const fixtureDir = join(process.cwd(), 'test', 'manifest-commands');

// listed in the order a directory scan returns them
const manifest = testManifest({
  root: process.cwd(),
  commands: [
    { name: 'manifest-alpha', className: 'AlphaCommand', options: [], arguments: [], source: sourceRef('test/manifest-commands/AlphaCommand.ts') },
    { name: 'manifest-beta', className: 'BetaCommand', options: [], arguments: [], source: sourceRef('test/manifest-commands/BetaCommand.ts') },
  ],
});

const logging = {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
};

const bootCli = async (mode: 'off' | 'require', dirs: string[]) => {
  const app = await createTestApp({
    config: { ...logging, system: { dirs: { cli: dirs } } },
    register: (c) => {
      withManifest(manifest, mode)(c);
      c.register(() => ['node', 'script.js', 'manifest-alpha']).as('__cli_argv_provider__', { replace: true });
    },
  });
  const cli = await app.resolve(Cli);
  return { app, commands: await cli.Commands };
};

describe('Cli with a manifest', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  it('lists the manifest commands with no system.dirs.cli, without globbing', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const { commands } = await bootCli('require', []);
    expect(commands.map((c) => c.name)).to.deep.equal(['AlphaCommand', 'BetaCommand']);
    expect(globSync.called).to.equal(false);
  });

  it('lists the same commands in the same order as the directory scan', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const scanned = await bootCli('off', [fixtureDir]);
    expect(globSync.called).to.equal(true);
    globSync.resetHistory();
    const scannedNames = scanned.commands.map((c): [string, unknown] => [c.name, c.type as unknown]);
    await disposeTestApps();

    const listed = await bootCli('require', []);
    expect(listed.commands.map((c): [string, unknown] => [c.name, c.type as unknown])).to.deep.equal(scannedNames);
    expect(globSync.called).to.equal(false);
    expect(scannedNames).to.have.length(2);
  });
});
