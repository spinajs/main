import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { buildAppManifest } from '../../src/index.js';

const WORKSPACE = resolve('../..');
const APP = resolve('test/fixtures/app-basic');
const TMP = resolve('test/fixtures/.tmp-e2e-boot');
const INSTALLED = join(TMP, 'app');
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
async function installApp(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(INSTALLED, { recursive: true });
  cpSync(join(APP, 'src'), join(INSTALLED, 'src'), { recursive: true });
  cpSync(join(APP, 'tsconfig.json'), join(INSTALLED, 'tsconfig.json'));

  // pkg-basic is another fixture package that is not built here, and only the app's entry point imports it
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  delete pkg.dependencies['pkg-basic'];
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(INSTALLED, 'package.json'), JSON.stringify({ ...pkg, workspaces: [] }));
  rmSync(join(INSTALLED, 'src', 'index.ts'));

  compileApp(INSTALLED);
  mkdirSync(join(INSTALLED, 'lib', 'config'), { recursive: true });
  writeFileSync(join(INSTALLED, 'lib', 'config', 'e2e.js'), E2E_CONFIG);

  const { manifest } = await buildAppManifest({ tsconfig: join(INSTALLED, 'tsconfig.json'), appRoot: INSTALLED, out: join(INSTALLED, 'app.manifest.json') });
  for (const { name } of manifest.packages) {
    const link = join(INSTALLED, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(INSTALLED, 'probe.mjs'), readFileSync(PROBE));
}

function boot(env: NodeJS.ProcessEnv): ProbeResult {
  const run = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: INSTALLED,
    encoding: 'utf8',
    timeout: 150_000,
    env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: INSTALLED, ...env },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}\n${result.error.stack}`);
  return result;
}

describe('app-basic boots from its manifest', function () {
  this.timeout(300_000);

  let required: ProbeResult;
  let discovered: ProbeResult;

  before(async function () {
    if (!existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'))) {
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    await installApp();
    required = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json') });
    discovered = boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1' });
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

  it('does not mount the explain route that its own source gates', () => {
    expect(required.responses.explain.status).to.equal(404);
    expect(required.controllers).to.not.include('ExplainController');
  });

  it('runs no directory scan and never loads typescript', () => {
    expect(required.scans.ancestorWalks).to.equal(0);
    expect(required.scans.controllerDirScans).to.equal(0);
    expect(required.scans.migrationDirScans).to.equal(0);
    // the app's own config dirs are still listed: configuration files are not a manifest section
    const globbed = required.scans.globPatterns.map((p) => p.slice(p.indexOf('/app/') + 5));
    expect(globbed.filter((p) => !/^(?:(?:src|lib|dist|build)\/)?config\//.test(p))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.deep.equal([]);
  });

  it('serves the same app as directory discovery', () => {
    // positive controls: the same spies do see a discovery boot
    expect(discovered.scans.controllerDirScans).to.be.greaterThan(0);
    expect(discovered.scans.migrationDirScans).to.be.greaterThan(0);
    const view = (r: ProbeResult) => ({ responses: r.responses, controllers: r.controllers, schedules: r.schedules, commands: r.commands, socketCommands: r.socketCommands, migrations: [...r.migrations].sort() });
    // @spinajs/tasks has no migration dir in its config: discovery registers its migration only once something imports the package
    expect(view(required)).to.deep.equal({ ...view(discovered), migrations: [...view(discovered).migrations, 'Task_2024_12_03_11_41_00'].sort() });
  });
});
