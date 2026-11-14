import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installApp, runProbe, WORKSPACE } from './support/install-app.js';

const APP = resolve('test/fixtures/orm-app');
const TMP = resolve('test/fixtures/.tmp-e2e-orm');
const PROBE = resolve('test/e2e/support/probe.orm.mjs');

const CONFIG = `
export default {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  db: { DefaultConnection: 'default', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { OnStartup: true, Table: 'orm_migrations' } }] },
};
`;

interface ProbeResult {
  error?: { name: string; message: string; stack: string };
  columns: { created: boolean; seen: boolean; active: unknown; roles: unknown };
  pets: string[];
  relationClass: string;
  tags: Array<{ name: string; link?: string; note?: string }>;
  names: string[];
  namesClass: string;
  updated: boolean;
  afterSoftDelete: unknown;
}

function install(emitDecoratorMetadata: boolean): Promise<string> {
  return installApp({
    app: APP,
    root: join(TMP, emitDecoratorMetadata ? 'metadata' : 'no-metadata'),
    config: CONFIG,
    probe: PROBE,
    tsconfig: (text) => text.replace('"emitDecoratorMetadata": true', `"emitDecoratorMetadata": ${String(emitDecoratorMetadata)}`),
  });
}

function run(root: string): ProbeResult {
  const result = runProbe<ProbeResult>(root);
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}\n${result.error.stack}`);
  return result;
}

describe('a timestamped model with relations, built with emitDecoratorMetadata: false', function () {
  this.timeout(300_000);

  let root: string;
  let withoutMetadata: ProbeResult;
  let withMetadata: ProbeResult;

  before(async function () {
    if (!existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'))) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    rmSync(TMP, { recursive: true, force: true });
    root = await install(false);
    withoutMetadata = run(root);
    withMetadata = run(await install(true));
  });

  after(() => {
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  });

  it('really has no decorator metadata in what it boots', () => {
    expect(readFileSync(join(root, 'lib', 'models.js'), 'utf8')).to.not.include('design:');
  });

  it('loads the model and converts its columns', () => {
    expect(withoutMetadata.columns).to.deep.equal({ created: true, seen: true, active: true, roles: ['admin', 'dev'] });
  });

  it('populates @HasMany and @HasManyToMany with their default relation lists', () => {
    expect(withoutMetadata.pets).to.deep.equal(['Rex']);
    expect(withoutMetadata.relationClass).to.equal('OneToManyRelationList');
    expect(withoutMetadata.tags.map((t) => t.name)).to.deep.equal(['vip']);
  });

  it('hydrates the @JunctionTable row into the class the property declares', () => {
    expect(withoutMetadata.tags[0]).to.deep.equal({ name: 'vip', link: 'OwnerTag', note: 'met at a fair' });
  });

  it('populates @Virtual through the class the property declares', () => {
    expect(withoutMetadata.namesClass).to.equal('PetNames');
    expect(withoutMetadata.names).to.deep.equal(['Rex']);
  });

  it('stamps updates and hides a soft deleted row', () => {
    expect(withoutMetadata.updated).to.equal(true);
    expect(withoutMetadata.afterSoftDelete).to.equal(null);
  });

  it('behaves exactly as the same app built with decorator metadata', () => {
    expect(withoutMetadata).to.deep.equal(withMetadata);
  });
});
