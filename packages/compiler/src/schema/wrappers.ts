import ts from 'typescript';
import { baseClassOf, extendsFrameworkClass, isDeclaredIn } from './framework-members.js';

/** Wrapper types unwrapped to their first type argument. Subclasses of the `@spinajs/http` `Response` are wrappers too. */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'Promise',
  'Ok',
  'Json',
  'Created',
  'BadRequest',
  'NotFound',
  'ServerError',
  'Unauthorized',
  'Forbidden',
  'Conflict',
  'NoContent',
  'ValidationError',
  'NotAllowed',
  'EntityTooLarge',
  'ModelDataWithRelationData',
  'ModelData',
]);

const HTTP = '@spinajs/http';
const isHttpResponse = (checker: ts.TypeChecker, type: ts.Type): boolean => extendsFrameworkClass(checker, type, 'Response', HTTP);
const isNullish = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

function singleWrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return undefined;
  return TRANSPARENT_WRAPPERS.has(symbol.name) || isHttpResponse(checker, type) ? symbol.name : undefined;
}

/** A union is a wrapper when every member is one (`Ok | Unauthorized`): one schema cannot describe several responses. */
export function wrapperName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!type.isUnion()) return singleWrapperName(checker, type);
  const names = type.types.filter((member) => !isNullish(member)).map((member) => singleWrapperName(checker, member));
  if (!names.length || names.some((name) => name === undefined)) return undefined;
  return [...new Set(names)].join(' | ');
}

function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (type.aliasSymbol) return type.aliasTypeArguments ?? [];
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference) : [];
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
