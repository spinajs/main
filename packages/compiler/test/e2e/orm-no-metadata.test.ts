import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { buildAppManifest } from '../../src/index.js';

const WORKSPACE = resolve('../..');
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

function compile(root: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: false, outDir: join(root, 'lib'), rootDir: join(root, 'src') } });
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
}

async function install(emitDecoratorMetadata: boolean): Promise<string> {
  const root = join(TMP, emitDecoratorMetadata ? 'metadata' : 'no-metadata');
  mkdirSync(root, { recursive: true });
  cpSync(join(APP, 'src'), join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), readFileSync(join(APP, 'tsconfig.json'), 'utf8').replace('"emitDecoratorMetadata": true', `"emitDecoratorMetadata": ${String(emitDecoratorMetadata)}`));
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as object), workspaces: [] }));

  compile(root);
  mkdirSync(join(root, 'lib', 'config'), { recursive: true });
  writeFileSync(join(root, 'lib', 'config', 'e2e.js'), CONFIG);

  const { manifest } = await buildAppManifest({ tsconfig: join(root, 'tsconfig.json'), appRoot: root, out: join(root, 'app.manifest.json') });
  for (const name of [...manifest.packages.map((p) => p.name), 'luxon']) {
    const link = join(root, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(root, 'probe.mjs'), readFileSync(PROBE));
  return root;
}

function run(root: string): ProbeResult {
  const probe = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: root, SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(root, 'app.manifest.json') },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(probe.stdout);
  if (!match) throw new Error(`probe failed (${String(probe.status)}):\n${probe.stdout}\n${probe.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
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
