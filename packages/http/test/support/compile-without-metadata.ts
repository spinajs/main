import ts from 'typescript';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Emits `<root>/src/**\/*.ts` to `<root>/lib` with the compiler options of `<root>/tsconfig.no-metadata.json`. Each
 * file is transpiled alone: a fixture importing the package's own `src` would otherwise drag it into its rootDir.
 */
export function compileWithoutMetadata(root: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.no-metadata.json'), (path) => ts.sys.readFile(path));
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const src = join(root, 'src');

  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const file = join(entry.parentPath, entry.name);
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: options, fileName: file });
    const out = join(root, 'lib', relative(src, file).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, outputText);
  }
}
