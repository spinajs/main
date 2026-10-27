import ts from 'typescript';
import { relative, resolve } from 'node:path';
import type { Diagnostic, SourceRef, TypeRef } from '@spinajs/manifest';
import type { LoadedProgram } from './program.js';
import { unwrapType } from './wrappers.js';

export interface ExtractorContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  packageName: string;
  packageRoot: string;
  sourceRef(node: ts.Node): SourceRef;
  typeRef(type: ts.Type, node: ts.Node): TypeRef;
  diagnostics: Diagnostic[];
  schemas: Record<string, unknown>;
  isSubclassOf(classNode: ts.ClassDeclaration, baseName: string): boolean;
  info(code: string, message: string, node?: ts.Node): void;
  warn(code: string, message: string, node?: ts.Node): void;
  error(code: string, message: string, node?: ts.Node): void;
}

export type Extractor<T> = (ctx: ExtractorContext, file: ts.SourceFile) => T[];

export function createContext(loaded: LoadedProgram, packageName: string, packageRoot: string): ExtractorContext {
  const root = resolve(packageRoot);
  const { checker } = loaded;
  const diagnostics: Diagnostic[] = [];

  const sourceRef = (node: ts.Node): SourceRef => {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: relative(root, resolve(sf.fileName)).replaceAll('\\', '/'), line: line + 1, col: character + 1, package: packageName };
  };

  const push =
    (severity: Diagnostic['severity']) =>
    (code: string, message: string, node?: ts.Node): void => {
      diagnostics.push({ code, severity, message, ...(node ? { source: sourceRef(node) } : {}) });
    };

  const baseChain = (type: ts.Type, seen = new Set<ts.Type>()): string[] => {
    if (seen.has(type) || !(type.flags & ts.TypeFlags.Object) || !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) return [];
    seen.add(type);
    return checker.getBaseTypes(type as ts.InterfaceType).flatMap((b) => [b.getSymbol()?.name ?? '', ...baseChain(b, seen)]);
  };

  return {
    program: loaded.program,
    checker,
    packageName,
    packageRoot: root,
    diagnostics,
    schemas: {},
    sourceRef,
    typeRef: (type) => ({
      text: checker.typeToString(unwrapType(type, checker), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope),
    }),
    isSubclassOf: (classNode, baseName) => baseChain(checker.getTypeAtLocation(classNode)).includes(baseName),
    info: push('info'),
    warn: push('warning'),
    error: push('error'),
  };
}
