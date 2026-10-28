import { existsSync } from 'fs';
import { join, posix } from 'path';
import { Project } from 'ts-morph';
import type { Transform } from './index.js';

export interface RunOptions {
  cwd: string;
  transforms: Transform[];
  dryRun: boolean;
  /** globs relative to cwd; replaces the file list of tsconfig.json */
  include?: string[];
}

const toPosix = (path: string) => path.replace(/\\/g, '/');

export function runTransforms(opts: RunOptions): Promise<{ changedFiles: string[] }> {
  const tsConfigFilePath = join(opts.cwd, 'tsconfig.json');
  if (!existsSync(tsConfigFilePath)) {
    return Promise.reject(new Error(`No tsconfig.json found in ${opts.cwd}; run the upgrade from the package root`));
  }

  const cwd = toPosix(opts.cwd);
  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: opts.include !== undefined,
    skipFileDependencyResolution: true,
  });
  if (opts.include) {
    project.addSourceFilesAtPaths(opts.include.map((glob) => posix.join(cwd, glob)));
  }

  const changedFiles: string[] = [];
  for (const file of project.getSourceFiles()) {
    const path = file.getFilePath();
    if (file.isDeclarationFile() || path.includes('/node_modules/')) {
      continue;
    }

    let changed = false;
    for (const transform of opts.transforms) {
      changed = transform.apply(project, file) || changed;
    }

    if (changed) {
      changedFiles.push(posix.relative(cwd, path));
      if (!opts.dryRun) {
        file.saveSync();
      }
    }
  }

  return Promise.resolve({ changedFiles: changedFiles.sort() });
}
