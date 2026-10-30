import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import { basename, extname, join } from 'node:path';
import type { ClassInfo } from '@spinajs/di';
import { createTestApp, disposeTestApps, sourceRef, testManifest, withManifest } from '@spinajs/testing';
import '@spinajs/log';
import { ScheduleRegistry } from '../src/index.js';

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'manifest-schedules');

// listed in the order a directory scan returns them
const manifest = testManifest({
  root: process.cwd(),
  schedules: [
    { name: 'manifest-alpha', className: 'AlphaSchedule', options: { every: '5m' }, source: sourceRef('test/fixtures/manifest-schedules/AlphaSchedule.ts') },
    { name: 'manifest-beta', className: 'BetaSchedule', options: { every: '10m' }, source: sourceRef('test/fixtures/manifest-schedules/BetaSchedule.ts') },
  ],
});

// the scan loads the .ts source under ts-node, the manifest names the built .js
const stemOf = (file: string) => basename(file, extname(file));

const logging = {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
};

const bootRegistry = async (mode: 'off' | 'require', dirs: string[]) => {
  const app = await createTestApp({ config: { ...logging, system: { dirs: { schedules: dirs } } }, register: withManifest(manifest, mode) });
  const registry = await app.resolve(ScheduleRegistry);
  const files = await (registry as unknown as { ScheduleFiles: Promise<Array<ClassInfo<unknown>>> }).ScheduleFiles;
  return { registry, files };
};

describe('ScheduleRegistry with a manifest', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  it('imports the manifest schedule files with no system.dirs.schedules, without globbing', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const { registry, files } = await bootRegistry('require', []);
    expect(files.map((f) => f.name)).to.deep.equal(['AlphaSchedule', 'BetaSchedule']);
    expect(registry.find('manifest-alpha')).to.not.equal(undefined);
    expect(registry.find('manifest-beta')).to.not.equal(undefined);
    expect(globSync.called).to.equal(false);
  });

  it('lists the same schedule files in the same order as the directory scan', async () => {
    const globSync = sinon.spy(glob, 'sync');
    const scanned = await bootRegistry('off', [fixtureDir]);
    expect(globSync.called).to.equal(true);
    const scannedFiles = scanned.files.map((f): [string, string, unknown] => [f.name, stemOf(f.file), f.type as unknown]);
    await disposeTestApps();

    globSync.resetHistory();
    const listed = await bootRegistry('require', []);
    expect(globSync.called).to.equal(false);
    expect(listed.files.map((f): [string, string, unknown] => [f.name, stemOf(f.file), f.type as unknown])).to.deep.equal(scannedFiles);
    expect(scannedFiles).to.have.length(2);
  });
});
