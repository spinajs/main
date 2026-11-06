import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoctorContext } from '../../src/doctor/index.js';
import { fixture } from './fixture.js';

describe('createDoctorContext sqlDialects', () => {
  it('reads package.json#spinajs.orm.dialects of the app root', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-sql-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a', spinajs: { orm: { dialects: { default: 'sqlite' } } } }));
    const manifest = fixture({ app: { name: 'a', version: '0.0.0', root, outDir: 'lib' } });
    expect(createDoctorContext(manifest, { cwd: root }).sqlDialects).to.deep.equal({ default: 'sqlite' });
  });

  it('leaves it out when the app declares none', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doctor-sql-none-'));
    expect(createDoctorContext(fixture(), { cwd })).to.not.have.property('sqlDialects');
  });
});
