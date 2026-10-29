import ts from 'typescript';

/** Wrapper types unwrapped to their first type argument. */
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

export const wrapperName = (type: ts.Type): string | undefined => {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol && TRANSPARENT_WRAPPERS.has(symbol.name) ? symbol.name : undefined;
};

export function isBareWrapper(type: ts.Type): boolean {
  return wrapperName(type) !== undefined;
}

function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (type.aliasSymbol) return type.aliasTypeArguments ?? [];
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference) : [];
}

/** Follows the first type argument while the type is a wrapper; a wrapper without arguments is returned as is. */
export function unwrapTransparent(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let current = type;
  for (let hops = 0; hops < 16 && wrapperName(current); hops++) {
    const args = typeArgumentsOf(checker, current);
    // `Ok` without an argument resolves to `Ok<any>` through the class default; that is a bare wrapper too.
    if (!args.length || (args[0].flags & ts.TypeFlags.Any && wrapperName(current) !== 'Promise')) return current;
    current = args[0];
  }
  return current;
}
