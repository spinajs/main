import 'mocha';
import { expect } from 'chai';
import { dirsMissing } from '../../src/doctor/rules/dirs-missing.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoctorContext } from '../../src/doctor/index.js';
import { fixture } from './fixture.js';

describe('CFG002 dirs-missing', () => {
  const base = { cwd: '/fixture', fragmentMtime: () => undefined, libMtime: () => undefined };

  it('is silent without config', () => {
    expect(dirsMissing.run(fixture(), { ...base, fileExists: () => false })).to.deep.equal([]);
  });

  it('reports every missing directory from system.dirs', () => {
    const ctx = { ...base, fileExists: (p: string) => p === '/ok', config: { system: { dirs: { controllers: ['/ok', '/gone'], cli: '/also-gone' } } } };
    expect(dirsMissing.run(fixture(), ctx)).to.deep.equal([
      { code: 'CFG002', severity: 'error', message: "system.dirs.controllers entry '/gone' does not exist" },
      { code: 'CFG002', severity: 'error', message: "system.dirs.cli entry '/also-gone' does not exist" },
    ]);
  });

  it('resolves relative directories against cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doctor-dirs-'));
    mkdirSync(join(cwd, 'present'));
    const ctx = createDoctorContext(fixture(), { cwd, config: { system: { dirs: { cli: ['present', 'absent'] } } } });
    expect(dirsMissing.run(fixture(), ctx)).to.deep.equal([
      { code: 'CFG002', severity: 'error', message: "system.dirs.cli entry 'absent' does not exist" },
    ]);
  });
});
