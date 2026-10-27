import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor, createDoctorContext, diagnostic, configAt, type DoctorRule } from '../../src/doctor/index.js';
import { fixture, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('runDoctor', () => {
  it('runs every rule and sorts error, warning, info, then by file and line', () => {
    const rules: DoctorRule[] = [
      { code: 'T2', describe: 'two', run: () => [diagnostic('T2', 'info', 'b', src('b.ts', 2)), diagnostic('T2', 'error', 'z', src('z.ts', 1))] },
      { code: 'T1', describe: 'one', run: () => [diagnostic('T1', 'warning', 'a', src('a.ts', 9)), diagnostic('T1', 'error', 'a', src('a.ts', 3))] },
    ];
    const out = runDoctor(fixture(), ctx, rules);
    expect(out.map((d) => `${d.severity} ${d.code} ${d.source?.file}:${d.source?.line}`)).to.deep.equal([
      'error T1 a.ts:3',
      'error T2 z.ts:1',
      'warning T1 a.ts:9',
      'info T2 b.ts:2',
    ]);
  });

  it('a rule that throws becomes one error diagnostic with its code', () => {
    const rules: DoctorRule[] = [
      {
        code: 'BOOM',
        describe: 'boom',
        run: () => {
          throw new Error('rule crashed');
        },
      },
    ];
    const out = runDoctor(fixture(), ctx, rules);
    expect(out).to.deep.equal([{ code: 'BOOM', severity: 'error', message: 'Rule BOOM failed: rule crashed' }]);
  });
});

describe('configAt', () => {
  it('reads nested paths and returns undefined for a missing segment', () => {
    expect(configAt({ a: { b: { c: 1 } } }, 'a.b.c')).to.equal(1);
    expect(configAt({ a: {} }, 'a.b.c')).to.equal(undefined);
    expect(configAt(undefined, 'a')).to.equal(undefined);
  });
});

describe('createDoctorContext', () => {
  it('reports file existence relative to cwd and fragment/lib mtimes per package', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doctor-'));
    mkdirSync(join(cwd, 'node_modules/@spinajs/x/lib'), { recursive: true });
    const fragment = join(cwd, 'node_modules/@spinajs/x/lib/manifest.fragment.json');
    const lib = join(cwd, 'node_modules/@spinajs/x/lib/index.js');
    writeFileSync(fragment, '{}');
    writeFileSync(lib, '');
    utimesSync(fragment, new Date(1_000_000), new Date(1_000_000));
    utimesSync(lib, new Date(2_000_000), new Date(2_000_000));
    const manifest = fixture({
      packages: [{ name: '@spinajs/x', version: '4.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: 'node_modules/@spinajs/x/lib/manifest.fragment.json' }],
    });
    const c = createDoctorContext(manifest, { cwd, config: { k: 1 } });
    expect(c.cwd).to.equal(cwd);
    expect(c.config).to.deep.equal({ k: 1 });
    expect(c.fileExists('node_modules/@spinajs/x/lib/index.js')).to.be.true;
    expect(c.fileExists('nope')).to.be.false;
    expect(c.fragmentMtime('@spinajs/x')).to.equal(1000 * 1000);
    expect(c.libMtime('@spinajs/x')).to.equal(2000 * 1000);
    expect(c.fragmentMtime('@spinajs/missing')).to.equal(undefined);
  });
});
