import ts from 'typescript';
import { baseClassOf, extendsFrameworkClass, isDeclaredIn } from './framework-members.js';

const MODEL_DATA: ReadonlySet<string> = new Set(['ModelDataWithRelationData', 'ModelData']);

/**
 * Wrapper types unwrapped to their first type argument, by name. The reply classes of `@spinajs/http` are not listed:
 * a subclass of its `Response` is a wrapper by its declaring package (`isHttpResponse`).
 */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(['Promise', ...MODEL_DATA]);

const HTTP = '@spinajs/http';
const ORM = '@spinajs/orm';
const isHttpResponse = (checker: ts.TypeChecker, type: ts.Type): boolean => extendsFrameworkClass(checker, type, 'Response', HTTP);
const isNullish = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

// The global `Promise` is one symbol (lib files and `declare global` merges); `ModelData*` come from the orm.
function isTransparentWrapper(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): symbol is ts.Symbol {
  if (!symbol || !TRANSPARENT_WRAPPERS.has(symbol.name)) return false;
  if (symbol.name === 'Promise') return symbol === checker.resolveName('Promise', undefined, ts.SymbolFlags.Type, false);
  return isDeclaredIn(symbol.declarations?.[0], ORM);
}

function referencedSymbol(checker: ts.TypeChecker, name: ts.EntityName): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

// A generic alias is followed only where it passes one of its own parameters straight on: `ModelData<T>`, not `ModelData<T[]>`.
function referenceArgument(checker: ts.TypeChecker, alias: ts.TypeAliasDeclaration, node: ts.TypeNode, args: readonly (ts.Type | undefined)[]): ts.Type | undefined {
  if (!alias.typeParameters?.length) return checker.getTypeFromTypeNode(node);
  if (!ts.isTypeReferenceNode(node) || node.typeArguments || !ts.isIdentifier(node.typeName)) return undefined;
  const name = node.typeName.text;
  const index = alias.typeParameters.findIndex((parameter) => parameter.name.text === name);
  return index < 0 ? undefined : args.at(index);
}

/**
 * The model of an `@spinajs/orm` alias in `names`, named directly or through type aliases of it (`type DataOf<T> = ModelData<T>`,
 * `type UserData = ModelData<User>`). Such an alias instantiates to a mapped type whose symbols name neither the orm
 * alias nor the model, so the alias declarations are followed instead.
 */
export function ormModelDataArgument(checker: ts.TypeChecker, type: ts.Type, names: ReadonlySet<string> = MODEL_DATA): ts.Type | undefined {
  let alias = type.aliasSymbol;
  let args: readonly (ts.Type | undefined)[] = type.aliasTypeArguments ?? [];
  for (let hops = 0; alias && hops < 16; hops++) {
    if (names.has(alias.name) && isDeclaredIn(alias.declarations?.[0], ORM)) return args[0];
    const declaration = alias.declarations?.[0];
    if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isTypeReferenceNode(declaration.type)) return undefined;
    const reference = declaration.type;
    alias = referencedSymbol(checker, reference.typeName);
    args = (reference.typeArguments ?? []).map((node) => referenceArgument(checker, declaration, node, args));
  }
  return undefined;
}

function singleWrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  // An alias of a wrapper (`type AsyncOk<T> = Promise<Ok<T>>`) is named by the alias; the wrapper is the type's own symbol.
  const wrapper = [type.aliasSymbol, type.getSymbol()].find((symbol) => isTransparentWrapper(checker, symbol));
  if (wrapper) return wrapper.name;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol && (isHttpResponse(checker, type) || ormModelDataArgument(checker, type)) ? symbol.name : undefined;
}

/** A union is a wrapper when every member is one (`Ok | Unauthorized`): one schema cannot describe several responses. */
export function wrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!type.isUnion()) return singleWrapperName(checker, type);
  const members = type.types.filter((member) => !isNullish(member));
  // `ModelData<M> | null` is nullable data, not a choice between responses: it derives member by member.
  if (members.length && members.every((member) => ormModelDataArgument(checker, member))) return undefined;
  const names = members.map((member) => singleWrapperName(checker, member));
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
  if (!isHttpResponse(checker, type)) return ormModelDataArgument(checker, type) ?? args[0];
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
