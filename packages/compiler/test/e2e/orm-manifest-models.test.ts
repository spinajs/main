import 'mocha';
import { expect } from 'chai';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readManifest } from '@spinajs/manifest';
import { generateConfigDeclarations } from '../../src/index.js';
import { installApp, runProbe, WORKSPACE } from './support/install-app.js';

const APP = resolve('test/fixtures/orm-manifest-app');
const TMP = resolve('test/fixtures/.tmp-e2e-orm-manifest');
const PROBE = resolve('test/e2e/support/probe.orm-manifest.mjs');

const CONFIG = `
export default {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  db: {
    Models: { Source: 'manifest' },
    StrictTableCheck: process.env.ORM_E2E_STRICT !== '0',
    DefaultConnection: 'default',
    Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { OnStartup: true, Table: 'orm_migrations' } }],
  },
};
`;

interface ProbeResult {
  error?: { name: string; message: string; stack: string };
  columns?: string[];
  drift?: string[];
  schema?: { types: Record<string, string>; required: string[] };
  seen?: unknown;
  legacy?: unknown;
  stored?: { name: string; legacy: string };
  stamp?: { id: string; updated: unknown };
}

describe('db.Models.Source = manifest in require mode', function () {
  this.timeout(300_000);

  let root: string;
  let clean: ProbeResult;

  before(async function () {
    if (!existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'))) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      process.stdout.write('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root\n');
      this.skip();
    }
    rmSync(TMP, { recursive: true, force: true });
    root = await installApp({ app: APP, root: join(TMP, 'app'), config: CONFIG, probe: PROBE });
    clean = runProbe<ProbeResult>(root);
  });

  after(() => {
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  });

  it('boots with the manifest columns only: no table merge, native types named by ColumnType', () => {
    expect(clean.error).to.equal(undefined);
    expect(clean.columns).to.deep.equal(['Active:boolean', 'Id:int', 'Name:string', 'Nickname:string', 'SeenAt:dateTime']);
    expect(clean.drift).to.deep.equal([]);
  });

  it('keeps the JSON schema types and derives required from TS optionality (Q18)', () => {
    // sqlite tableInfo would have given Id INTEGER -> integer as well; the family must not degrade it to string
    expect(clean.schema?.types).to.deep.equal({ Id: 'integer', Name: 'string', Active: 'boolean', Nickname: 'string', SeenAt: 'string' });
    // Nickname?: is optional and the auto-increment Id is never required (schema.ts:81); under Source = 'database' required came from the table's NOT NULL flags instead
    expect(clean.schema?.required).to.deep.equal(['Active', 'Name']);
  });

  it('converts a column with the converter of its family', () => {
    // dateTime, which no default converter key covers under db.Models.Source = 'database'
    expect(clean.seen).to.equal(true);
  });

  it('declares db.Models.Source in the typed configuration declarations', async () => {
    const source = await generateConfigDeclarations(await readManifest(join(root, 'app.manifest.json')), { modules: ['db'] });
    expect(source).to.include("'db.Models.Source': 'database' | 'manifest';");
  });

  it('hydrates an undeclared column raw and never writes it back', () => {
    expect(clean.legacy).to.equal('kept');
    expect(clean.stored).to.deep.equal({ name: 'grace', legacy: 'kept' });
  });

  it('inserts a model whose required @UpdatedAt the insert leaves empty: the manifest records it nullable', () => {
    expect(clean.error).to.equal(undefined);
    expect(clean.stamp).to.deep.equal({ id: 'number', updated: null });
  });

  it('fails the boot on a declared column the table lacks, under db.StrictTableCheck', () => {
    const result = runProbe<ProbeResult>(root, { ORM_E2E_DRIFT: '1' });
    expect(result.error?.message).to.include('Column drift (db.StrictTableCheck): column Nickname of model Account is missing from table accounts on connection default');
  });

  it('only reports it without db.StrictTableCheck', () => {
    const result = runProbe<ProbeResult>(root, { ORM_E2E_DRIFT: '1', ORM_E2E_STRICT: '0' });
    expect(result.error).to.equal(undefined);
    expect(result.drift).to.deep.equal(['column Nickname of model Account is missing from table accounts on connection default']);
  });
});
