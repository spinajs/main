import ts from 'typescript';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { ManifestValidator } from '@spinajs/validation';

// Under the package's node_modules, so `@spinajs/client/mocks` resolves to the built lib/ through the workspace link.
const cacheDir = fileURLToPath(new URL('../../node_modules/.mocks-test/', import.meta.url));
let loaded = 0;

export type MockFunction = (overrides?: unknown, options?: { seed?: number; optional?: 'some' | 'all' }) => unknown;

export interface MocksModule {
  createMockAppClient(impl?: object, options?: { fallback?: 'throw' | 'mock'; seed?: number }): Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  [name: string]: unknown;
}

/** Imports generated `client.mocks.ts` source, transpiled; its type-only import of `client.js` disappears. */
export async function loadMocks(contents: string): Promise<MocksModule> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `client${loaded++}.mocks.mjs`);
  writeFileSync(file, ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return (await import(pathToFileURL(file).href)) as MocksModule;
}

export function clearMocks(): void {
  rmSync(cacheDir, { recursive: true, force: true });
}

export function mockFunction(module: MocksModule, name: string): MockFunction {
  const fn = module[`mock${name}`];
  if (typeof fn !== 'function') throw new Error(`client.mocks.ts exports no mock${name}`);
  return fn as MockFunction;
}

/** The server's check of a JSON body against schema `id`: no coercion, closed root. Returns the error text, or undefined. */
export function serverCheck(manifest: Manifest): (id: string, value: unknown) => string | undefined {
  const validator = new ManifestValidator(manifest);
  return (id, value) => {
    try {
      validator.validator(id, { coerce: false })(value);
      return undefined;
    } catch (e) {
      const errors = (e as { parameter?: unknown }).parameter;
      return `${(e as Error).message} ${JSON.stringify(errors ?? '')} for ${JSON.stringify(value)}`;
    }
  };
}
