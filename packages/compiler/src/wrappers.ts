import ts from 'typescript';

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

export function unwrapType(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  let current = type;
  for (let depth = 0; depth < 10; depth++) {
    const name = current.aliasSymbol?.name ?? current.getSymbol()?.name;
    if (!name || !TRANSPARENT_WRAPPERS.has(name)) return current;
    const args = checker.getTypeArguments(current as ts.TypeReference);
    if (args.length === 0) return checker.getVoidType();
    current = args[0];
  }
  return current;
}
