import ts from 'typescript';

export interface Ancestor<T> {
  entry: T;
  declaration: ts.ClassDeclaration;
}

const declaredTypeOf = (cls: ts.ClassDeclaration, checker: ts.TypeChecker): ts.Type | undefined => {
  const symbol = cls.name && checker.getSymbolAtLocation(cls.name);
  return symbol && checker.getDeclaredTypeOfSymbol(symbol);
};

/** The type of `member` as `cls` sees it: a generic base's member is instantiated with what `cls` binds. */
export function methodTypeOf(cls: ts.ClassDeclaration, member: string, checker: ts.TypeChecker): ts.Type | undefined {
  const type = declaredTypeOf(cls, checker);
  const prop = type && checker.getPropertyOfType(type, member);
  return prop && checker.getTypeOfSymbolAtLocation(prop, cls);
}

/** The closest class up the `extends` chain for which `entryOf` has an entry; classes without one are walked through. */
export function nearestAncestor<T>(node: ts.ClassDeclaration, checker: ts.TypeChecker, entryOf: (decl: ts.ClassDeclaration) => T | undefined): Ancestor<T> | undefined {
  for (let type = declaredTypeOf(node, checker); type; ) {
    const [base] = type.isClassOrInterface() ? checker.getBaseTypes(type) : [];
    const declaration = base?.getSymbol()?.declarations?.find(ts.isClassDeclaration);
    if (!declaration) return undefined;
    const entry = entryOf(declaration);
    if (entry !== undefined) return { entry, declaration };
    type = declaredTypeOf(declaration, checker);
  }
  return undefined;
}
