import ts from 'typescript';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RequestHandler } from 'msw';
import type { GeneratedFile } from '../../src/index.js';

// Under the package's node_modules, so `msw` and `@spinajs/client/*` resolve through the workspace.
const cacheDir = fileURLToPath(new URL('../../node_modules/.msw-test/', import.meta.url));
let loaded = 0;

export interface HandlerOverrides {
  [controller: string]: { [handler: string]: unknown } | undefined;
}

export interface LoadedFiles {
  createAppClient(options: { baseUrl: string; fetch?: typeof fetch }): Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  createAppHandlers(baseUrl: string, overrides?: HandlerOverrides): RequestHandler[];
}

/** Imports the generated files side by side, transpiled, so their relative `.js` imports resolve to each other. */
export async function loadGenerated(files: GeneratedFile[]): Promise<LoadedFiles> {
  const dir = join(cacheDir, `run${loaded++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  for (const file of files) {
    const { outputText } = ts.transpileModule(file.contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, file.path.replace(/\.ts$/, '.js')), outputText);
  }
  const client = (await import(pathToFileURL(join(dir, 'client.js')).href)) as Pick<LoadedFiles, 'createAppClient'>;
  const msw = (await import(pathToFileURL(join(dir, 'client.msw.js')).href)) as Pick<LoadedFiles, 'createAppHandlers'>;
  return { ...client, ...msw };
}

export function clearGenerated(): void {
  rmSync(cacheDir, { recursive: true, force: true });
}
