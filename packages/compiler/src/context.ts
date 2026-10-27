import ts from 'typescript';
import { relative, resolve } from 'node:path';
import type { Diagnostic, SourceRef, TypeRef } from '@spinajs/manifest';
import type { LoadedProgram } from './program.js';
import { deriveSchema, type JsonSchema } from './schema/derive.js';
import { sanitizeName } from './schema/naming.js';
import { unwrapTransparent, wrapperName } from './schema/wrappers.js';

export interface ExtractorContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  packageName: string;
  packageRoot: string;
  sourceRef(node: ts.Node): SourceRef;
  typeRef(type: ts.Type, node: ts.Node, nameHint?: string): TypeRef;
  diagnostics: Diagnostic[];
  schemas: Record<string, unknown>;
  /** Schemas derived from TypeScript types, keyed by `$id`. */
  schemaRegistry: Map<string, JsonSchema>;
  isSubclassOf(classNode: ts.ClassDeclaration, baseName: string): boolean;
  info(code: string, message: string, node?: ts.Node): void;
  warn(code: string, message: string, node?: ts.Node): void;
  error(code: string, message: string, node?: ts.Node): void;
}

/** Symbol-based so instantiated generics (`Base<string>`) pass while anonymous object types do not. */
export function isClassOrInterfaceType(type: ts.Type): boolean {
  return !!type.symbol && !!(type.symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface));
}

export type Extractor<T> = (ctx: ExtractorContext, file: ts.SourceFile) => T[];

export interface ContextOptions {
  schemaDerivation?: boolean;
}

export function createContext(loaded: LoadedProgram, packageName: string, packageRoot: string, options: ContextOptions = {}): ExtractorContext {
  const root = resolve(packageRoot);
  const { checker } = loaded;
  const diagnostics: Diagnostic[] = [];
  const schemaRegistry = new Map<string, JsonSchema>();
  const schemaDerivation = options.schemaDerivation ?? true;

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
    if (seen.has(type) || !(type.flags & ts.TypeFlags.Object) || !isClassOrInterfaceType(type)) return [];
    seen.add(type);
    return checker.getBaseTypes(type as ts.InterfaceType).flatMap((b) => [b.getSymbol()?.name ?? '', ...baseChain(b, seen)]);
  };

  const typeRef = (type: ts.Type, node: ts.Node, nameHint?: string): TypeRef => {
    const payload = unwrapTransparent(checker, type);
    const bare = wrapperName(payload);
    const text = bare ?? checker.typeToString(payload, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    const ref: TypeRef = { text };
    if (!schemaDerivation || bare || payload.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return ref;

    const result = deriveSchema(checker, payload, node, { idPrefix: `spinajs/${packageName}/`, maxDepth: 20, sourceRef }, schemaRegistry);
    diagnostics.push(...result.diagnostics);
    let id = result.id;
    if (!id && nameHint) {
      id = `spinajs/${packageName}/${sanitizeName(nameHint)}`;
      schemaRegistry.set(id, { $id: id, ...result.schema });
    }
    if (id) ref.schema = id;
    return ref;
  };

  return {
    program: loaded.program,
    checker,
    packageName,
    packageRoot: root,
    diagnostics,
    schemas: {},
    sourceRef,
    schemaRegistry,
    typeRef,
    isSubclassOf: (classNode, baseName) => baseChain(checker.getTypeAtLocation(classNode)).includes(baseName),
    info: push('info'),
    warn: push('warning'),
    error: push('error'),
  };
}
