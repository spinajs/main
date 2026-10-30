import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { buildAppManifest } from '../../src/index.js';

const WORKSPACE = resolve('../..');
const APP = resolve('test/fixtures/app-basic');
const TMP = resolve('test/fixtures/.tmp-e2e-boot');
const INSTALLED = join(TMP, 'app');
const INSTALLED_NO_METADATA = join(TMP, 'app-no-metadata');
const PROBE = resolve('test/e2e/support/probe.boot.mjs');

// What an app ships in its own config. `system.dirs` is set for the discovery run only: the manifest run has none.
const E2E_CONFIG = `
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const provider = (name) => ({ service: 'fsNative', name, basePath: tmpdir() });
const dirs = (...names) => names.map((n) => join(process.cwd(), 'lib', n));

export default {
  ...(process.env.E2E_SCAN === '1'
    ? { system: { dirs: { controllers: dirs('controllers'), migrations: dirs('migrations'), schedules: dirs('schedules'), cli: dirs('commands'), socketControllers: dirs('socket') } } }
    : {}),
  ...(process.env.E2E_EXPLAIN === '1' ? { authz: { http: { explainRoute: { enabled: true } } } } : {}),
  fs: { defaultProvider: 'fs-temp', providers: [provider('fs-temp'), provider('__fs_controller_cache__')] },
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  intl: { locales: ['en'], defaultLocale: 'en' },
  http: { port: 0 },
  db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { OnStartup: false } }] },
};
`;

interface ProbeResult {
  unsupported?: string;
  error?: { name: string; message: string; stack: string };
  imports: Array<{ specifier: string; parent: string }>;
  scans: { ancestorWalks: number; controllerDirScans: number; migrationDirScans: number; globPatterns: string[] };
  responses: Record<string, { status: number; body: unknown }>;
  controllers: string[];
  migrations: string[];
  schedules: string[];
  commands: string[];
  socketCommands: string[];
}

/** Emits the fixture to `lib/` with its own tsconfig, without the `noEmit` of the analysis config; discovery reads the .d.ts files. */
function compileApp(root: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: false, outDir: join(root, 'lib'), rootDir: join(root, 'src') };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
}

/** The app as a deployment lays it out: its own lib/ and a node_modules/@spinajs holding only the packages it depends on. */
async function installApp(installed: string, emitDecoratorMetadata: boolean): Promise<void> {
  rmSync(installed, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  cpSync(join(APP, 'src'), join(installed, 'src'), { recursive: true });
  const tsconfig = readFileSync(join(APP, 'tsconfig.json'), 'utf8').replace('"emitDecoratorMetadata": true', `"emitDecoratorMetadata": ${String(emitDecoratorMetadata)}`);
  writeFileSync(join(installed, 'tsconfig.json'), tsconfig);

  // pkg-basic is another fixture package that is not built here, and only the app's entry point imports it
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  delete pkg.dependencies['pkg-basic'];
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...pkg, workspaces: [] }));
  rmSync(join(installed, 'src', 'index.ts'));

  compileApp(installed);
  mkdirSync(join(installed, 'lib', 'config'), { recursive: true });
  writeFileSync(join(installed, 'lib', 'config', 'e2e.js'), E2E_CONFIG);

  const { manifest } = await buildAppManifest({ tsconfig: join(installed, 'tsconfig.json'), appRoot: installed, out: join(installed, 'app.manifest.json') });
  for (const { name } of manifest.packages) {
    const link = join(installed, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(installed, 'probe.mjs'), readFileSync(PROBE));
}

function boot(env: NodeJS.ProcessEnv, installed = INSTALLED): ProbeResult {
  const run = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: installed,
    encoding: 'utf8',
    timeout: 150_000,
    env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: installed, ...env },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}\n${result.error.stack}`);
  return result;
}

const view = (r: ProbeResult) => ({ responses: r.responses, controllers: r.controllers, schedules: r.schedules, commands: r.commands, socketCommands: r.socketCommands, migrations: [...r.migrations].sort() });

describe('app-basic boots from its manifest', function () {
  this.timeout(300_000);

  let required: ProbeResult;
  let requiredWithoutMetadata: ProbeResult;
  let discovered: ProbeResult;
  let explainRequired: ProbeResult;
  let explainDiscovered: ProbeResult;

  before(async function () {
    if (!existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'))) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    rmSync(TMP, { recursive: true, force: true });
    await installApp(INSTALLED, true);
    await installApp(INSTALLED_NO_METADATA, false);
    required = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json') });
    requiredWithoutMetadata = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED_NO_METADATA, 'app.manifest.json') }, INSTALLED_NO_METADATA);
    discovered = boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1' });
    explainRequired = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json'), E2E_EXPLAIN: '1' });
    explainDiscovered = boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1', E2E_EXPLAIN: '1' });
  });

  after(() => {
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  });

  it('serves routes, lists migrations, schedules, commands and socket commands', () => {
    expect(required.responses.health).to.deep.equal({ status: 200, body: { ok: true } });
    expect(required.responses.users).to.deep.equal({ status: 200, body: [{ id: 1, email: 'ada@example.com', name: 'Ada' }] });
    expect(required.controllers).to.include.members(['HealthController', 'UsersController']);
    expect(required.migrations).to.include('AppBasic_2026_10_27_00_00_00');
    expect(required.schedules).to.include('basic-task');
    expect(required.commands).to.include('BasicCommand');
    expect(required.socketCommands).to.include.members(['chat.send', 'chat.history']);
  });

  it('does not mount the explain route, which only its own source serves', () => {
    expect(required.responses.explain.status).to.equal(404);
    expect(required.controllers).to.not.include('ExplainController');
  });

  it('serves the explain route through its own source when the flag is on, in require as in off mode', () => {
    expect(explainDiscovered.controllers).to.include('ExplainController');
    expect(explainRequired.controllers).to.include('ExplainController');
    expect(explainRequired.responses.explain.status).to.not.equal(404);
    expect(explainRequired.responses.explain.status).to.equal(explainDiscovered.responses.explain.status);
  });

  it('lists no abstract controller base', () => {
    expect(required.controllers).to.not.include.members(['UploadController']);
    expect(required.controllers.filter((c) => /Base$/.test(c))).to.deep.equal([]);
  });

  it('runs no directory scan and never loads typescript', () => {
    expect(required.scans.ancestorWalks).to.equal(0);
    expect(required.scans.controllerDirScans).to.equal(0);
    expect(required.scans.migrationDirScans).to.equal(0);
    // the app's own config dirs are still listed: configuration files are not a manifest section
    const globbed = required.scans.globPatterns.map((p) => relative(INSTALLED, p).split(sep).join('/'));
    expect(globbed.filter((p) => !/^(?:(?:src|lib|dist|build)\/)?config\//.test(p))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.deep.equal([]);
  });

  it('serves the same app as directory discovery', () => {
    // positive controls: the same spies do see a discovery boot
    expect(discovered.scans.controllerDirScans).to.be.greaterThan(0);
    expect(discovered.scans.migrationDirScans).to.be.greaterThan(0);
    expect(discovered.imports.some((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.equal(true);
    expect(view(required)).to.deep.equal(view(discovered));
  });

  describe('built with emitDecoratorMetadata: false', () => {
    it('really has no decorator metadata in what it boots', () => {
      const emitted = readdirSync(join(INSTALLED_NO_METADATA, 'lib'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
      expect(emitted).to.include.members([join('controllers', 'users.js')]);
      expect(emitted.filter((f) => readFileSync(join(INSTALLED_NO_METADATA, 'lib', f), 'utf8').includes('design:'))).to.deep.equal([]);
      expect(readFileSync(join(INSTALLED, 'lib', 'controllers', 'users.js'), 'utf8')).to.include('design:paramtypes');
    });

    it('boots in require mode with zero scans and serves the same app', () => {
      expect(requiredWithoutMetadata.scans.ancestorWalks).to.equal(0);
      expect(requiredWithoutMetadata.scans.controllerDirScans).to.equal(0);
      expect(requiredWithoutMetadata.scans.migrationDirScans).to.equal(0);
      expect(requiredWithoutMetadata.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
      expect(view(requiredWithoutMetadata)).to.deep.equal(view(required));
    });
  });
});
