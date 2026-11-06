/** Stands in for `@spinajs/orm`'s `@Version()` (D16, lane O): the analyzer matches the decorator by name. */
export function Version(): PropertyDecorator {
  return () => undefined;
}
