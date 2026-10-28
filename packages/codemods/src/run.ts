import { existsSync } from 'fs';
import { dirname, join, posix } from 'path';
import { Project, SourceFile, ts } from 'ts-morph';
import type { Transform } from './index.js';

export interface RunOptions {
  cwd: string;
  transforms: Transform[];
  dryRun: boolean;
  /** globs relative to cwd; replaces the file list of tsconfig.json */
  include?: string[];
}

export interface FailedFile {
  file: string;
  transform: string;
  error: string;
}

export interface Warning {
  file: string;
  line: number;
  message: string;
}

export interface RunResult {
  changedFiles: string[];
  /** files a transform threw on; they are left untouched on disk */
  failedFiles: FailedFile[];
  /** things a transform found but could not rewrite */
  warnings: Warning[];
  /** number of source files visited */
  scannedFiles: number;
}

/** the files tsconfig.json selects, as if allowJs were on: JS/CJS config files hold the typeof module switch */
function tsconfigFiles(tsConfigFilePath: string): string[] {
  const { config } = ts.readConfigFile(tsConfigFilePath, (path) => ts.sys.readFile(path));
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(tsConfigFilePath), { allowJs: true }, tsConfigFilePath).fileNames;
}

const toPosix = (path: string) => path.replace(/\\/g, '/');

interface FileOutcome {
  changed: boolean;
  failure?: FailedFile;
  warnings: Warning[];
}

function applyTransforms(file: SourceFile, rel: string, transforms: Transform[]): FileOutcome {
  const warnings: Warning[] = [];
  let changed = false;
  for (const transform of transforms) {
    try {
      changed =
        transform.apply(file.getProject(), file, (node, message) => warnings.push({ file: rel, line: node.getStartLineNumber(), message })) || changed;
    } catch (err) {
      file.refreshFromFileSystemSync();
      return { changed: false, failure: { file: rel, transform: transform.name, error: (err as Error).message }, warnings: [] };
    }
  }
  return { changed, warnings };
}

export function runTransforms(opts: RunOptions): Promise<RunResult> {
  const tsConfigFilePath = join(opts.cwd, 'tsconfig.json');
  if (!existsSync(tsConfigFilePath)) {
    return Promise.reject(new Error(`No tsconfig.json found in ${opts.cwd}; run the upgrade from the package root`));
  }

  const cwd = toPosix(opts.cwd);
  const project = new Project({
    tsConfigFilePath,
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  project.addSourceFilesAtPaths(opts.include ? opts.include.map((glob) => posix.join(cwd, glob)) : tsconfigFiles(tsConfigFilePath));

  const result: RunResult = { changedFiles: [], failedFiles: [], warnings: [], scannedFiles: 0 };
  for (const file of project.getSourceFiles()) {
    const path = file.getFilePath();
    if (file.isDeclarationFile() || path.includes('/node_modules/')) {
      continue;
    }

    result.scannedFiles++;
    const rel = posix.relative(cwd, path);
    const outcome = applyTransforms(file, rel, opts.transforms);
    if (outcome.failure) {
      result.failedFiles.push(outcome.failure);
      continue;
    }

    result.warnings.push(...outcome.warnings);
    if (outcome.changed) {
      result.changedFiles.push(rel);
      if (!opts.dryRun) {
        file.saveSync();
      }
    }
  }

  result.changedFiles.sort();
  return Promise.resolve(result);
}
