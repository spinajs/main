import ts from 'typescript';
import type { DeriveContext } from './derive.js';
import { wellKnownSchema } from './wellknown.js';

const NAMED = ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum | ts.SymbolFlags.TypeAlias;

export function sanitizeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

const inDefaultLib = (symbol: ts.Symbol): boolean => symbol.declarations?.[0]?.getSourceFile().hasNoDefaultLib === true;

function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type, viaAlias: boolean): readonly ts.Type[] {
  if (viaAlias) return type.aliasTypeArguments ?? [];
  const reference = type as ts.TypeReference;
  if (reference.target && reference.target !== type && reference.target.flags & ts.TypeFlags.Object) return checker.getTypeArguments(reference);
  return [];
}

/** A class, interface or enum names the type; an alias names it only when the type is anonymous. */
function namingSymbol(type: ts.Type): { symbol: ts.Symbol; viaAlias: boolean } | undefined {
  const own = type.getSymbol();
  if (own && own.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum)) return { symbol: own, viaAlias: false };
  if (type.aliasSymbol) return { symbol: type.aliasSymbol, viaAlias: true };
  return own ? { symbol: own, viaAlias: false } : undefined;
}

function argumentName(checker: ts.TypeChecker, type: ts.Type): string {
  return hoistedName(checker, type) ?? sanitizeName(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation));
}

export function hoistedName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.EnumLiteral))) return undefined;
  if (checker.isArrayType(type) || checker.isTupleType(type) || wellKnownSchema(type)) return undefined;

  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return undefined;
  // Pick/Omit/Record results carry the user alias that names them, not the lib alias; mapped types stay anonymous.
  if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) return undefined;

  const naming = namingSymbol(type);
  if (!naming || !(naming.symbol.flags & NAMED) || inDefaultLib(naming.symbol)) return undefined;
  const { symbol, viaAlias } = naming;

  const args = typeArgumentsOf(checker, type, viaAlias).map((argument) => argumentName(checker, argument));
  return sanitizeName([symbol.name, ...args].join('_'));
}

export function hoistedId(ctx: DeriveContext, type: ts.Type): string | undefined {
  const cached = ctx.seen.get(type);
  if (cached) return cached;
  const name = hoistedName(ctx.checker, type);
  if (!name) return undefined;
  const id = ctx.options.idPrefix + name;
  ctx.seen.set(type, id);
  return id;
}
