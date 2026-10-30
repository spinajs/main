import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoctorContext, runDoctor } from '../../src/doctor/index.js';
import { fixture } from './fixture.js';

describe('BLD001 in a hoisted workspace', () => {
  let ws: string;
  let appRoot: string;

  before(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-hoisted-')));
    appRoot = join(ws, 'packages/app');
    const lib = join(ws, 'node_modules/@spinajs/dep/lib');
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    writeFileSync(join(ws, 'node_modules/@spinajs/dep/package.json'), JSON.stringify({ name: '@spinajs/dep', version: '1.0.0' }));
    writeFileSync(join(lib, 'manifest.fragment.json'), '{}');
    writeFileSync(join(lib, 'index.js'), '');
    utimesSync(join(lib, 'index.js'), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(lib, 'manifest.fragment.json'), new Date(2_000_000), new Date(2_000_000));
  });

  after(() => rmSync(ws, { recursive: true, force: true }));

  const manifest = () =>
    fixture({
      app: { name: 'app', version: '1.0.0', root: appRoot, outDir: 'lib' },
      packages: [{ name: '@spinajs/dep', version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: 'node_modules/@spinajs/dep/lib/manifest.fragment.json' }],
    });

  it('reports the same diagnostics from the package dir, the workspace root and an unrelated dir', () => {
    const m = manifest();
    const from = (cwd: string) => runDoctor(m, createDoctorContext(m, { cwd }));
    expect(from(appRoot).filter((d) => d.code === 'BLD001')).to.deep.equal([]);
    expect(from(ws)).to.deep.equal(from(appRoot));
    expect(from(tmpdir())).to.deep.equal(from(appRoot));
  });
});
