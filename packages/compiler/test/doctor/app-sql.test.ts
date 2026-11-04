import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { mergeFragments } from '@spinajs/manifest';
import { analyzePackage, createDoctorContext, formatDiagnostics, runDoctor } from '../../src/index.js';

describe('spinajs doctor on an app with sql templates', () => {
  it('prints SQL003 with the file and line of the template', async () => {
    const root = resolve('test/fixtures/app-sql');
    const app = await analyzePackage({ tsconfig: 'test/fixtures/app-sql/tsconfig.json', packageRoot: root });
    const manifest = mergeFragments(app, [], { app: { name: app.package.name, version: app.package.version, root, outDir: app.package.outDir }, packages: [], generatedAt: '2026-11-03T00:00:00.000Z' });
    const sql = runDoctor(manifest, createDoctorContext(manifest, { cwd: root })).filter((d) => d.code.startsWith('SQL'));
    expect(formatDiagnostics(sql, 'text')).to.deep.equal(['error   SQL003   src/queries.ts:4:22  Column Emial is not declared on accounts', '1 error(s), 0 warning(s), 0 info']);
  });
});
