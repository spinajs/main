import ts from 'typescript';
import { baseClassOf, extendsFrameworkClass, isDeclaredIn } from './framework-members.js';

/**
 * Wrapper types unwrapped to their first type argument, by name. The reply classes of `@spinajs/http` are not listed:
 * a subclass of its `Response` is a wrapper by its declaring package (`isHttpResponse`).
 */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(['Promise', 'ModelDataWithRelationData', 'ModelData']);

const HTTP = '@spinajs/http';
const ORM = '@spinajs/orm';
const isHttpResponse = (checker: ts.TypeChecker, type: ts.Type): boolean => extendsFrameworkClass(checker, type, 'Response', HTTP);
const isNullish = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

// The global `Promise` is declared in default lib files, `ModelData*` in the orm: an application type of that name is no wrapper.
function isTransparentWrapper(symbol: ts.Symbol | undefined): symbol is ts.Symbol {
  if (!symbol || !TRANSPARENT_WRAPPERS.has(symbol.name)) return false;
  const declarations = symbol.declarations ?? [];
  return symbol.name === 'Promise' ? declarations.some((d) => d.getSourceFile().hasNoDefaultLib) : isDeclaredIn(declarations[0], ORM);
}

function singleWrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  // An alias of a wrapper (`type AsyncOk<T> = Promise<Ok<T>>`) is named by the alias; the wrapper is the type's own symbol.
  const wrapper = [type.aliasSymbol, type.getSymbol()].find(isTransparentWrapper);
  if (wrapper) return wrapper.name;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol && isHttpResponse(checker, type) ? symbol.name : undefined;
}

/** A union is a wrapper when every member is one (`Ok | Unauthorized`): one schema cannot describe several responses. */
export function wrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!type.isUnion()) return singleWrapperName(checker, type);
  const names = type.types.filter((member) => !isNullish(member)).map((member) => singleWrapperName(checker, member));
  if (!names.length || names.some((name) => name === undefined)) return undefined;
  return [...new Set(names)].join(' | ');
}

// The reference's own arguments win over an alias's: `type OkList<T> = Ok<T[]>` passes `T[]`, not `T`, and
// `type Missing = NotFound<P>` has none. A mapped or intersection alias (`ModelData<M>`) has only the alias's.
function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  if (isReference) return checker.getTypeArguments(type as ts.TypeReference);
  return type.aliasTypeArguments ?? [];
}

function payloadOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const args = typeArgumentsOf(checker, type);
  if (!isHttpResponse(checker, type)) return args[0];
  // A non-generic response (`BufferResponse extends Response<Buffer>`) names its payload on the base class.
  if (!args.length) return baseClassOf(checker, type);
  // http's own generic responses pass the payload as their first type argument; a user subclass's need not be it.
  return isDeclaredIn(type.getSymbol()?.declarations?.[0], HTTP) ? args[0] : undefined;
}

/** Follows the payload while the type is a wrapper; a wrapper without one, or a union of wrappers, is returned as is. */
export function unwrapTransparent(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let current = type;
  for (let hops = 0; hops < 16 && !current.isUnion() && wrapperName(checker, current); hops++) {
    const payload = payloadOf(checker, current);
    // `Ok` without an argument resolves to `Ok<any>` through the class default; that is a bare wrapper too.
    if (!payload || (payload.flags & ts.TypeFlags.Any && wrapperName(checker, current) !== 'Promise')) return current;
    current = payload;
  }
  return current;
}
