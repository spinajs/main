import ts from 'typescript';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Manifest, ParamEntry, RouteEntry } from '@spinajs/manifest';
import { zodRoot } from './typecheck.js';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

export function param(index: number, name: string, kind: string, wire: ParamEntry['wire'], schema?: string, text = 'unknown'): ParamEntry {
  return { index, name, kind, runtimeType: { text, ...(schema ? { schema } : {}) }, required: true, ...(wire ? { wire } : {}) };
}

export function route(handler: string, method: RouteEntry['method'], params: ParamEntry[]): RouteEntry {
  return { method, path: '', handler, fullPath: `/items/${handler}`, params, returnType: { text: 'void' }, policies: [], middlewares: [], source };
}

/**
 * `base` with its controllers replaced by one, which sends each named schema as a whole body: so `client.ts`
 * declares an interface per name, and `client.zod.ts` a schema.
 */
export function manifestWith(base: Manifest, named: Record<string, unknown>, extra: Record<string, unknown> = {}, routes: RouteEntry[] = []): Manifest {
  const ids = Object.keys(named).map((name) => `test/${name}`);
  const bodies = ids.map((id, i) => route(`send${i}`, 'post', [param(0, 'body', 'FromBody', { in: 'body', shape: 'whole' }, id, id.slice(5))]));
  const schemas = Object.fromEntries([...Object.entries(named).map(([name, s]) => [`test/${name}`, s]), ...Object.entries(extra)]);
  return {
    ...base,
    schemas,
    controllers: [{ id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes: [...bodies, ...routes], source }],
    socketControllers: [],
  };
}

// Under node_modules, so that the module resolution of the generated files finds zod and `@spinajs/client`.
const cacheRoot = fileURLToPath(new URL('../../node_modules/.zod-test/', import.meta.url));

export interface ZodLoader {
  loadZod(contents: string): Promise<Record<string, unknown>>;
  clearLoaded(): void;
}

/**
 * A loader with a folder of its own. Mocha processes of the package run side by side (the full suite, a fuzz seed, a diff
 * script), and a folder or a file name they share lets one delete or overwrite what another is about to import.
 */
export function createZodLoader(): ZodLoader {
  let dir: string | undefined;
  let loaded = 0;
  const clearLoaded = (): void => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  };
  process.once('exit', clearLoaded);
  return {
    clearLoaded,
    async loadZod(contents) {
      if (!dir) {
        mkdirSync(cacheRoot, { recursive: true });
        dir = mkdtempSync(join(cacheRoot, `${process.pid}-`));
      }
      const file = join(dir, `client${loaded++}.zod.mjs`);
      const output = ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(file, process.env.ZOD_ROOT ? output.replace(/from '(zod(?:\/mini)?)'/, (_m, id: string) => `from '${pathToFileURL(join(zodRoot, id === 'zod' ? 'index.js' : 'mini/index.js')).href}'`) : output);
      return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    },
  };
}

const shared = createZodLoader();

/** Imports generated `client.zod.ts` source: transpiled, from a folder whose module resolution finds zod and `@spinajs/client`. */
export const loadZod = shared.loadZod;

export const clearLoaded = shared.clearLoaded;

export interface SafeParse {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

export function schemaIn(module: Record<string, unknown>, name: string): SafeParse {
  const schema = module[name] as SafeParse | undefined;
  if (!schema || typeof schema.safeParse !== 'function') throw new Error(`client.zod.ts exports no schema ${name}`);
  return schema;
}
