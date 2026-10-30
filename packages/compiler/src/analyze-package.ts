import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { MANIFEST_VERSION, type Diagnostic, type ManifestFragment, type SourceRef } from '@spinajs/manifest';
import { compareCodeUnits } from './sort.js';
import { createProgramFromTsconfig } from './program.js';
import { createContext, type Extractor } from './context.js';
import { extractServices, mergeById } from './extractors/services.js';
import { extractValues } from './extractors/values.js';
import { extractConfigModules, extractConfigUsages } from './extractors/config.js';
import { extractControllers } from './extractors/controllers.js';
import { extractSocketContracts, extractSocketControllers } from './extractors/socket.js';
import { extractModels } from './extractors/models.js';
import { extractMigrations } from './extractors/migrations.js';
import { extractSchedules } from './extractors/schedules.js';
import { extractCommands } from './extractors/commands.js';
import { extractQueueMessages } from './extractors/queue.js';

export interface AnalyzeOptions {
  tsconfig: string;
  packageRoot: string;
  /** Derive JSON Schemas from TypeScript types (default true). */
  schemaDerivation?: boolean;
}

const compareSource = (a: SourceRef, b: SourceRef): number => compareCodeUnits(a.file, b.file) || a.line - b.line || a.col - b.col;

export function sortBySource<T extends { source: SourceRef }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => compareSource(a.source, b.source));
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (!a.source || !b.source) return a.source ? 1 : b.source ? -1 : compareCodeUnits(a.code, b.code);
    return compareSource(a.source, b.source) || compareCodeUnits(a.code, b.code);
  });
}

export function outDirOf(rootDir: string, outDir: string | undefined): string {
  return outDir ? relative(rootDir, outDir).split(sep).join('/') || '.' : 'lib';
}

const BUILT_EXTENSIONS: Readonly<Record<string, string>> = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs', '.js': '.js', '.mjs': '.mjs', '.cjs': '.cjs', '.json': '.json' };

/**
 * Built names of the files under `src/config`, relative to the outDir: what the runtime globs from
 * `<package>/<outDir>/config` when it runs without a manifest.
 */
export function configFilesOf(packageRoot: string): string[] {
  const dir = join(packageRoot, 'src', 'config');
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || /\.d\.[mc]?ts$/.test(entry.name)) continue;
    const ext = /\.[^.]+$/.exec(entry.name)?.[0] ?? '';
    const built = BUILT_EXTENSIONS[ext];
    if (!built) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    out.push(`config/${rel.slice(0, rel.length - ext.length)}${built}`);
  }
  return out.sort(compareCodeUnits);
}

export function analyzePackage(options: AnalyzeOptions): Promise<ManifestFragment> {
  const root = resolve(options.packageRoot);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string; main?: string };
  const loaded = createProgramFromTsconfig(options.tsconfig);
  const ctx = createContext(loaded, pkg.name, root, { schemaDerivation: options.schemaDerivation });
  const files = [...loaded.sourceFiles].sort((a, b) => compareCodeUnits(a.fileName, b.fileName));

  const run = <T extends { source: SourceRef }>(extractor: Extractor<T>): T[] => sortBySource(files.flatMap((f) => extractor(ctx, f)));

  const fragment: ManifestFragment = {
    manifestVersion: MANIFEST_VERSION,
    package: {
      name: pkg.name,
      version: pkg.version,
      entry: (pkg.main ?? 'lib/index.js').replace(/^\.\//, ''),
      outDir: outDirOf(root, loaded.program.getCompilerOptions().outDir),
      configFiles: configFilesOf(root),
    },
    services: sortBySource(mergeById(files.flatMap((f) => extractServices(ctx, f)))),
    values: run(extractValues),
    controllers: run(extractControllers),
    socketControllers: run(extractSocketControllers),
    socketContracts: run(extractSocketContracts),
    configModules: run(extractConfigModules),
    configUsages: run(extractConfigUsages),
    models: run(extractModels),
    migrations: run(extractMigrations),
    schedules: run(extractSchedules),
    commands: run(extractCommands),
    queueMessages: run(extractQueueMessages),
    schemas: Object.fromEntries([...Object.entries(ctx.schemas), ...ctx.schemaRegistry].sort(([a], [b]) => compareCodeUnits(a, b))),
    diagnostics: sortDiagnostics(ctx.diagnostics),
  };
  return Promise.resolve(fragment);
}
