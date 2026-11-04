import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ModuleDir {
  import<T>(file: string): Promise<T>;
  remove(): void;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Writes generated files as ES modules into a temporary directory, `.ts` transpiled to `.js`, with each import
 * specifier in `rewrite` replaced (a bare package by a file URL, or a generated file by a stub).
 */
export function writeModules(files: Record<string, string>, rewrite: Record<string, string> = {}): ModuleDir {
  const dir = mkdtempSync(join(tmpdir(), 'client-modules-'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  for (const [name, contents] of Object.entries(files)) {
    let js = name.endsWith('.ts') ? ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText : contents;
    for (const [from, to] of Object.entries(rewrite)) js = js.replace(new RegExp(`from '${escape(from)}'`, 'g'), `from '${to}'`);
    writeFileSync(join(dir, name.replace(/\.ts$/, '.js')), js);
  }
  return {
    import: <T>(file: string) => import(pathToFileURL(join(dir, file)).href) as Promise<T>,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
