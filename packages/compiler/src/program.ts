import ts from 'typescript';
import { dirname, resolve } from 'node:path';

export interface LoadedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
  sourceFiles: ts.SourceFile[];
}

export function createProgramFromTsconfig(tsconfigPath: string): LoadedProgram {
  const abs = resolve(tsconfigPath);
  const read = ts.readConfigFile(abs, ts.sys.readFile);
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
  return { program, checker: program.getTypeChecker(), rootDir, sourceFiles };
}
