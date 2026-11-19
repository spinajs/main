import ts from 'typescript';

/** The JSDoc tag a framework package writes on its own declarations: `@spinajs <role> [value]`. */
export const MARKER_TAG = 'spinajs';

function markerIn(tag: ts.JSDocTag, role: string): string | undefined {
  if (tag.tagName.text !== MARKER_TAG) return undefined;
  // One token: a description on the next line is part of the tag's comment, not of the marker.
  const [name = '', value = ''] = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/);
  return name === role ? value : undefined;
}

export function declarationMarker(declaration: ts.Node | undefined, role: string): string | undefined {
  if (declaration === undefined) return undefined;
  for (const tag of ts.getJSDocTags(declaration)) {
    const value = markerIn(tag, role);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A class merged with an interface has a declaration of each; either may carry the marker. */
export function symbolMarker(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, role: string): string | undefined {
  if (symbol === undefined) return undefined;
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of target.declarations ?? []) {
    const value = declarationMarker(declaration, role);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function typeMarker(checker: ts.TypeChecker, type: ts.Type, role: string): string | undefined {
  const seen = new Set<ts.Symbol>();
  const visit = (current: ts.Type): string | undefined => {
    const symbol = current.getSymbol() ?? current.aliasSymbol;
    if (symbol === undefined || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const own = symbolMarker(checker, symbol, role);
    if (own !== undefined) return own;
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    if (!declared.isClassOrInterface()) return undefined;
    for (const base of checker.getBaseTypes(declared)) {
      const inherited = visit(base);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  };
  return visit(type);
}
