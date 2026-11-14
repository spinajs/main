import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Key = readonly unknown[];
type KeyFactory = (vars?: unknown) => Key;

export interface KeysModule {
  appKeys: Record<string, Key | Record<string, Key | KeyFactory>>;
  appTags: Record<string, Record<string, string>>;
  clientShapeHash: string;
}

/** Transpiles a generated `client.keys.ts` and imports it; the file has only type imports, so it loads alone. */
export async function loadKeys(contents: string): Promise<KeysModule> {
  const { outputText } = ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const dir = mkdtempSync(join(tmpdir(), 'client-keys-'));
  try {
    const file = join(dir, 'client.keys.mjs');
    writeFileSync(file, outputText);
    return (await import(pathToFileURL(file).href)) as KeysModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isKey = (value: unknown): value is Key => Array.isArray(value);

/** Every key the module builds, with each query key called on `vars` (or on nothing). */
export function keyTable(keys: KeysModule, vars: Record<string, unknown> = {}): Record<string, Key> {
  const table: Record<string, Key> = {};
  for (const [controller, entries] of Object.entries(keys.appKeys)) {
    if (isKey(entries)) {
      table[controller] = entries;
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      const path = `${controller}.${name}`;
      table[path] = isKey(entry) ? entry : entry(vars[path]);
    }
  }
  return table;
}
