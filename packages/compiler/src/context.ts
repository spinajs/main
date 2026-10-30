import ts from 'typescript';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Diagnostic, SourceRef, TypeRef } from '@spinajs/manifest';
import type { LoadedProgram } from './program.js';
import { deriveSchema, type DeriveOptions, type JsonSchema } from './schema/derive.js';
import { isQueueFrameworkMember } from './schema/framework-members.js';
import { sanitizeName } from './schema/naming.js';
import { unwrapTransparent, wrapperName } from './schema/wrappers.js';

export interface ExtractorContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  packageName: string;
  packageRoot: string;
  sourceRef(node: ts.Node): SourceRef;
  typeRef(type: ts.Type, node: ts.Node, nameHint?: string, derive?: Pick<DeriveOptions, 'excludeMembersOf'>): TypeRef;
  /** Type text only, no schema derivation (binary payloads such as uploaded files). */
  plainTypeRef(type: ts.Type): TypeRef;
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

function ownerName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if ((ts.isClassLike(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) && current.name) return current.name.text;
  }
  return undefined;
}

export interface ContextOptions {
  schemaDerivation?: boolean;
}

export function createContext(loaded: LoadedProgram, packageName: string, packageRoot: string, options: ContextOptions = {}): ExtractorContext {
  const root = resolve(packageRoot);
  const { checker } = loaded;
  const diagnostics: Diagnostic[] = [];
  const schemaRegistry = new Map<string, JsonSchema>();
  const schemaDerivation = options.schemaDerivation ?? true;
  const schemaOwners = new Map<string, ts.Type>();
  const hintSources = new Map<string, SourceRef>();

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

  const inPackage = (node: ts.Node): boolean => {
    const rel = relative(root, resolve(node.getSourceFile().fileName));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules');
  };

  const textOf = (payload: ts.Type): string =>
    wrapperName(payload) ?? checker.typeToString(payload, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);

  const typeRef = (type: ts.Type, node: ts.Node, nameHint?: string, derive: Pick<DeriveOptions, 'excludeMembersOf'> = {}): TypeRef => {
    const payload = unwrapTransparent(checker, type);
    const bare = wrapperName(payload);
    const ref: TypeRef = { text: textOf(payload) };
    if (!schemaDerivation || bare || payload.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return ref;

    const derivation: DeriveOptions = {
      idPrefix: `spinajs/${packageName}/`,
      maxDepth: 20,
      // A type declared outside the package is reported at its use site, so fragments do not depend on the install layout.
      sourceRef: (n) => sourceRef(inPackage(n) ? n : node),
      foreignOwner: (n) => (inPackage(n) ? undefined : ownerName(n)),
      owners: schemaOwners,
      excludeMembersOf: isQueueFrameworkMember,
      ...derive,
    };
    const result = deriveSchema(checker, payload, node, derivation, schemaRegistry);
    diagnostics.push(...result.diagnostics);
    let id = result.id;
    if (!id && nameHint) {
      id = `spinajs/${packageName}/${sanitizeName(nameHint)}`;
      const body: JsonSchema = { $id: id, ...result.schema };
      const existing = schemaRegistry.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(body)) {
        const first = hintSources.get(id);
        const here = sourceRef(node);
        push('warning')('SCH005', `schema id ${id} is produced by two different types, first at ${first ? `${first.file}:${first.line}` : 'an earlier use'}, again at ${here.file}:${here.line}`, node);
      }
      schemaRegistry.set(id, body);
      if (!hintSources.has(id)) hintSources.set(id, sourceRef(node));
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
    plainTypeRef: (type) => ({ text: textOf(unwrapTransparent(checker, type)) }),
    isSubclassOf: (classNode, baseName) => baseChain(checker.getTypeAtLocation(classNode)).includes(baseName),
    info: push('info'),
    warn: push('warning'),
    error: push('error'),
  };
}
