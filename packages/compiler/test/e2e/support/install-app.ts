import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { buildAppManifest } from '../../../src/index.js';

export const WORKSPACE = resolve('../..');

export interface InstallOptions {
  /** Fixture app with `src/`, `tsconfig.json` and `package.json`. */
  app: string;
  root: string;
  /** Body of `lib/config/e2e.js`. */
  config: string;
  probe: string;
  tsconfig?: (text: string) => string;
}

function compile(root: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: false, outDir: join(root, 'lib'), rootDir: join(root, 'src') } });
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
}

/** Copies the fixture app to `root`, compiles it, builds its manifest, and links the packages the manifest names. */
export async function installApp(options: InstallOptions): Promise<string> {
  const { app, root } = options;
  mkdirSync(root, { recursive: true });
  cpSync(join(app, 'src'), join(root, 'src'), { recursive: true });
  const tsconfig = readFileSync(join(app, 'tsconfig.json'), 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), options.tsconfig ? options.tsconfig(tsconfig) : tsconfig);
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as object), workspaces: [] }));

  compile(root);
  mkdirSync(join(root, 'lib', 'config'), { recursive: true });
  writeFileSync(join(root, 'lib', 'config', 'e2e.js'), options.config);

  const { manifest } = await buildAppManifest({ tsconfig: join(root, 'tsconfig.json'), appRoot: root, out: join(root, 'app.manifest.json') });
  for (const name of [...manifest.packages.map((p) => p.name), 'luxon']) {
    const link = join(root, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(root, 'probe.mjs'), readFileSync(options.probe));
  return root;
}

/** Runs the installed probe in require mode and parses what it printed between the JSON markers. */
export function runProbe<T>(root: string, env: Record<string, string> = {}): T {
  const probe = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: root, SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(root, 'app.manifest.json'), ...env },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(probe.stdout);
  if (!match) throw new Error(`probe failed (${String(probe.status)}):\n${probe.stdout}\n${probe.stderr}`);
  return JSON.parse(match[1]) as T;
}
