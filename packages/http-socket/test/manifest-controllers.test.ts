import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { DI, type ClassInfo } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { sourceRef, testManifest } from '@spinajs/testing';
import { SocketHandlerRegistry } from '../src/registry.js';
import { ITestServer, manifestFromEnv, startServer } from './harness.js';

const fixtureDir = join(process.cwd(), 'test', 'manifest-controllers');

const entry = (className: string, prefix: string) => ({
  id: `test-app:${className}`,
  className,
  prefix,
  commands: [],
  events: [],
  source: sourceRef(`test/manifest-controllers/${className}.ts`),
});

// listed in the order a directory scan returns them
const manifest = testManifest({
  root: process.cwd(),
  socketControllers: [entry('AlphaSocket', 'mfa'), entry('BetaSocket', 'mfb')],
});

// the scan loads the .ts source under ts-node, the manifest names the built .js
const stemOf = (file: string) => basename(file, extname(file));

// config files are globbed by the configuration sources; only a scan of the controller dir counts
const scansFixtures = (spy: sinon.SinonSpy) => spy.getCalls().some((c) => String(c.args[0]).includes('manifest-controllers'));

describe('SocketServer with a manifest', function () {
  this.timeout(20000);

  let dir: string;
  let server: ITestServer | undefined;
  let restoreEnv: (() => void) | undefined;

  const start = async (mode: 'off' | 'require', dirs: string[]) => {
    restoreEnv = manifestFromEnv(mode, join(dir, 'app.manifest.json'));
    server = await startServer({ system: { dirs: { socketControllers: dirs } } });
    const files = await (server.server as unknown as { ControllerFiles: Promise<Array<ClassInfo<unknown>>> }).ControllerFiles;
    return { files: files.map((f): [string, string, unknown] => [f.name, stemOf(f.file), f.type as unknown]), registry: await DI.resolve(SocketHandlerRegistry) };
  };

  const stop = async () => {
    await server?.close();
    server = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'socket-manifest-'));
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify(manifest));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  afterEach(async () => {
    sinon.restore();
    await stop();
  });

  it('loads the manifest socket controllers with no system.dirs.socketControllers, without globbing', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const { files, registry } = await start('require', []);
    expect(files.map((f) => f[0])).to.deep.equal(['AlphaSocket', 'BetaSocket']);
    await registry.build();
    expect(registry.command('mfa.add')).to.not.equal(undefined);
    expect(registry.command('mfb.add')).to.not.equal(undefined);
    expect(scansFixtures(globSync)).to.equal(false);
  });

  it('lists the same controllers in the same order as the directory scan', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const scanned = await start('off', [fixtureDir]);
    expect(scansFixtures(globSync)).to.equal(true);
    await stop();

    globSync.resetHistory();
    const listed = await start('require', []);
    expect(scansFixtures(globSync)).to.equal(false);
    expect(listed.files).to.deep.equal(scanned.files);
    expect(scanned.files).to.have.length(2);
  });
});
