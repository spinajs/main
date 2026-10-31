import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { Manifest } from '@spinajs/manifest';
import { buildAppManifest } from '../../../src/index.js';

const WORKSPACE = resolve('../..');
const APP = resolve('test/fixtures/app-basic');
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

export interface SocketReply {
  ok: boolean;
  id?: string;
  result?: unknown;
  error?: { code: string; message: string; details?: { errors: Array<{ path: string; keyword: string; message: string }> } };
}

export interface ProbeResult {
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
  socketReplies: SocketReply[];
}

/** Whether the workspace packages were built with their manifest fragments, which the installed app links to. */
export const hasBuiltFragments = (): boolean => existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'));

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

export interface InstalledApp {
  root: string;
  manifestPath: string;
  manifest: Manifest;
  boot(env: NodeJS.ProcessEnv): ProbeResult;
}

export interface AppExtras {
  /** Extra files of the app, by path relative to its root */
  sources?: Record<string, string>;
  /** Extra packages the app depends on */
  dependencies?: string[];
}

/** app-basic as a deployment lays it out: its own lib/ and a node_modules holding only the packages it depends on. */
export async function installApp(tmp: string, extras: AppExtras = {}): Promise<InstalledApp> {
  const root = join(tmp, 'app');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(APP, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(APP, 'tsconfig.json'), join(root, 'tsconfig.json'));
  for (const [file, content] of Object.entries(extras.sources ?? {})) writeFileSync(join(root, file), content);

  // pkg-basic is another fixture package that is not built here, and only the app's entry point imports it
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  delete pkg.dependencies['pkg-basic'];
  for (const name of extras.dependencies ?? []) pkg.dependencies[name] = '*';
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, workspaces: [] }));
  rmSync(join(root, 'src', 'index.ts'));

  compileApp(root);
  mkdirSync(join(root, 'lib', 'config'), { recursive: true });
  writeFileSync(join(root, 'lib', 'config', 'e2e.js'), E2E_CONFIG);

  const manifestPath = join(root, 'app.manifest.json');
  const { manifest } = await buildAppManifest({ tsconfig: join(root, 'tsconfig.json'), appRoot: root, out: manifestPath });
  for (const { name } of manifest.packages) {
    const link = join(root, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(root, 'probe.mjs'), readFileSync(PROBE));

  const boot = (env: NodeJS.ProcessEnv): ProbeResult => {
    const run = spawnSync(process.execPath, ['probe.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 150_000,
      env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: root, ...env },
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(match[1]) as ProbeResult;
    if (result.unsupported) throw new Error(result.unsupported);
    if (result.error) throw new Error(`${result.error.name}: ${result.error.message}\n${result.error.stack}`);
    return result;
  };

  return { root, manifestPath, manifest, boot };
}
