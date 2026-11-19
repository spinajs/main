import type ts from 'typescript';

/** Has a callable `then`, as `await` requires. */
export function isAwaitable(checker: ts.TypeChecker, type: ts.Type): boolean {
  const then = checker.getNonNullableType(type).getProperty('then');
  return then !== undefined && checker.getTypeOfSymbol(then).getCallSignatures().length > 0;
}

/** Has a `[Symbol.asyncIterator]` member, as `for await` requires. The checker names that member `__@asyncIterator@<id>`. */
export function isAsyncIterable(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker
    .getNonNullableType(type)
    .getProperties()
    .some((property) => property.name.startsWith('__@asyncIterator'));
}
