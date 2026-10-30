import ts from 'typescript';
import { relative } from 'node:path';
import type { RuntimeTypeRef } from '@spinajs/manifest';
import { owningPackage } from './owning-package.js';

export const globalRef = (name: string): RuntimeTypeRef => ({ package: 'global', file: '', export: name });

/** A global constructor, a class to locate, or `undefined` for what the metadata records as `void 0`. */
type Serialized = { global: string } | { cls: ts.Symbol } | undefined;

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never;

const PRIMITIVES: ReadonlyArray<[ts.TypeFlags, string]> = [
  [ts.TypeFlags.BooleanLike, 'Boolean'],
  [ts.TypeFlags.StringLike, 'String'],
  [ts.TypeFlags.NumberLike, 'Number'],
  [ts.TypeFlags.BigIntLike, 'BigInt'],
  [ts.TypeFlags.ESSymbolLike, 'Symbol'],
];

const keyOf = (s: Serialized): string | ts.Symbol | undefined => (s === undefined ? undefined : 'global' in s ? s.global : s.cls);

/** The same merged symbol as the global value of that name: `Date`, `Uint8Array`, node's `Buffer`. */
function isGlobalValue(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const found = checker.resolveName(symbol.name, undefined, ts.SymbolFlags.Value, false);
  return !!found?.declarations?.some((d) => symbol.declarations?.includes(d));
}

/** `typeof Foo`: the type of the constructor, not of an instance. */
const isStaticSide = (type: ts.Type): boolean => !!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous);

/** `declare class X` in a source file emits nothing; a declaration file stands for JavaScript next to it. */
function isDeclaredOnly(symbol: ts.Symbol): boolean {
  const decl = symbol.valueDeclaration;
  return !!decl && !decl.getSourceFile().isDeclarationFile && !!(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient);
}

/**
 * TypeScript's decorator metadata serializer works on the type annotation; this mirrors it on the checked type, so
 * `null`/`undefined` members are dropped, a union of one constructor is that constructor and any other union is `Object`.
 */
function serialize(type: ts.Type, checker: ts.TypeChecker): Serialized {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return { global: 'Object' };
  const primitive = PRIMITIVES.find(([flags]) => type.flags & flags);
  if (primitive) return { global: primitive[1] };
  if (type.isUnionOrIntersection()) {
    const members = type.types.filter((t) => !(t.flags & NULLISH)).map((t) => serialize(t, checker));
    if (members.length === 0) return undefined;
    return members.every((m) => m !== undefined && keyOf(m) === keyOf(members[0])) ? members[0] : { global: 'Object' };
  }
  if (type.flags & NULLISH) return undefined;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return { global: 'Array' };

  const symbol = type.getSymbol();
  // The metadata reads `typeof X !== 'undefined' ? X : Object`, which is `Object` for lib.dom's classes on node.
  if (symbol && isGlobalValue(symbol, checker)) return { global: symbol.name in globalThis ? symbol.name : 'Object' };
  if (symbol && symbol.flags & ts.SymbolFlags.Class && !isStaticSide(type) && !isDeclaredOnly(symbol)) return { cls: symbol };
  return { global: type.getCallSignatures().length ? 'Function' : 'Object' };
}

function exportNameOf(cls: ts.Symbol, file: ts.SourceFile, checker: ts.TypeChecker): string | undefined {
  const module = checker.getSymbolAtLocation(file);
  if (!module) return undefined;
  const found = checker.getExportsOfModule(module).find((e) => (e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e) === cls);
  return found?.name;
}

export interface RuntimeRefHost {
  checker: ts.TypeChecker;
  packageName: string;
  packageRoot: string;
  inPackage(node: ts.Node): boolean;
  info(code: string, message: string, node?: ts.Node): void;
}

const NOT_LOADABLE = 'without decorator metadata the runtime cannot load it';

/** `declare module 'name' { ... }`: a node built-in or an untyped package, never a file the manifest lists. */
function ambientModuleOf(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) return current.name.text;
  }
  return undefined;
}

const notImportable = (cls: ts.Symbol, where: string, node: ts.Node, host: RuntimeRefHost): undefined => {
  host.info('TYP002', `runtime-type-not-importable: ${cls.name} is declared in ${where}, which ships no manifest fragment; ${NOT_LOADABLE}`, node);
  return undefined;
};

function classRef(cls: ts.Symbol, node: ts.Node, host: RuntimeRefHost): RuntimeTypeRef | undefined {
  const decl = cls.valueDeclaration ?? cls.declarations?.[0];
  if (!decl) return undefined;
  const ambient = ambientModuleOf(decl);
  if (ambient) return notImportable(cls, `module '${ambient}'`, node, host);
  const file = decl.getSourceFile();
  const name = exportNameOf(cls, file, host.checker);
  const at = (root: string) => relative(root, file.fileName).replaceAll('\\', '/');

  if (!name) {
    host.info('TYP001', `runtime-type-not-exported: ${cls.name} is not exported from ${at(host.packageRoot)}; ${NOT_LOADABLE}`, node);
    return undefined;
  }
  if (host.inPackage(decl)) return file.isDeclarationFile ? globalRef('Object') : { package: host.packageName, file: at(host.packageRoot), export: name };

  const owner = owningPackage(file.fileName);
  if (!owner?.fragment) return notImportable(cls, owner?.name ?? file.fileName, node, host);
  // A dependency is seen through its declaration files; the runtime imports the JavaScript next to them.
  return { package: owner.name, file: at(owner.root).replace(/\.d\.([mc]?)ts$/, '.$1js'), export: name };
}

/** What `design:type` / `design:paramtypes` would hold for `type`, as a reference the runtime can import. */
export function runtimeRefOf(type: ts.Type, node: ts.Node, host: RuntimeRefHost): RuntimeTypeRef | undefined {
  const serialized = serialize(type, host.checker);
  if (serialized === undefined) return undefined;
  return 'global' in serialized ? globalRef(serialized.global) : classRef(serialized.cls, node, host);
}
