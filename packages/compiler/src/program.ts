import ts from 'typescript';
import { dirname, resolve, sep } from 'node:path';

export interface LoadedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
  /** The folder tsc mirrors under `outDir`. */
  emitRoot: string;
  sourceFiles: ts.SourceFile[];
}

/**
 * What tsc takes as `rootDir`: the option, the tsconfig folder of a composite project, else the common folder of its
 * inputs. TypeScript does not export that last computation.
 */
export function emitRootOf(rootDir: string | undefined, composite: boolean | undefined, tsconfigDir: string, sourceFiles: readonly string[]): string {
  if (rootDir || composite) return resolve(rootDir ?? tsconfigDir);
  const [first, ...rest] = sourceFiles.map((f) => dirname(resolve(f)).split(sep));
  if (!first) return resolve(tsconfigDir);
  let common = first.length;
  for (const parts of rest) {
    let shared = 0;
    while (shared < common && parts[shared] === first[shared]) shared++;
    common = shared;
  }
  return first.slice(0, common).join(sep) || sep;
}

export function createProgramFromTsconfig(tsconfigPath: string): LoadedProgram {
  const abs = resolve(tsconfigPath);
  const read = ts.readConfigFile(abs, (p) => ts.sys.readFile(p));
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(abs));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    projectReferences: parsed.projectReferences,
  });
  const rootDir = resolve(parsed.options.rootDir ?? dirname(abs));
  const sourceFiles = program.getSourceFiles().filter((f) => !f.isDeclarationFile && resolve(f.fileName).startsWith(rootDir));
  const emitRoot = emitRootOf(parsed.options.rootDir, parsed.options.composite, dirname(abs), sourceFiles.map((f) => f.fileName));
  return { program, checker: program.getTypeChecker(), rootDir, emitRoot, sourceFiles };
}
