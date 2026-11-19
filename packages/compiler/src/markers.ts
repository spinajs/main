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

interface Marked {
  readonly value: string;
  readonly declaration: ts.Declaration;
}

/** A class merged with an interface has a declaration of each; either may carry the marker. */
function markedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, role: string): Marked | undefined {
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of target.declarations ?? []) {
    const value = declarationMarker(declaration, role);
    if (value !== undefined) return { value, declaration };
  }
  return undefined;
}

export function symbolMarker(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, role: string): string | undefined {
  return symbol === undefined ? undefined : markedSymbol(checker, symbol, role)?.value;
}

export interface MarkedType extends Marked {
  /** The type arguments the asked type gives the carrier, mapped through the base chain. */
  readonly typeArguments: readonly ts.Type[];
}

const isReference = (t: ts.Type): t is ts.TypeReference => (t.flags & ts.TypeFlags.Object) !== 0 && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;

/** The arguments of a reference without the trailing `this` argument the checker adds to a base class reference. */
function argumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (!isReference(type)) return [];
  const all = checker.getTypeArguments(type);
  return all.slice(0, type.target.typeParameters?.length ?? all.length);
}

/**
 * The marker of `type` or of the first of its bases that carries one, with that declaration. Answers for `type` as
 * given and its bases: a caller splits a union or intersection first.
 */
export function markedType(checker: ts.TypeChecker, type: ts.Type, role: string): MarkedType | undefined {
  const seen = new Set<ts.Symbol>();
  const visit = (current: ts.Type, typeArguments: readonly ts.Type[]): MarkedType | undefined => {
    const symbol = current.getSymbol() ?? current.aliasSymbol;
    if (symbol === undefined || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const own = markedSymbol(checker, symbol, role);
    if (own !== undefined) return { ...own, typeArguments };
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    if (!declared.isClassOrInterface()) return undefined;
    const parameters: readonly ts.Type[] = declared.typeParameters ?? [];
    for (const base of checker.getBaseTypes(declared)) {
      // Only an argument that is a parameter itself is mapped; a composed one (`T[]`) keeps the base's own text.
      const mapped = argumentsOf(checker, base).map((argument) => {
        const at = parameters.indexOf(argument);
        return at >= 0 ? (typeArguments.at(at) ?? argument) : argument;
      });
      const inherited = visit(base, mapped);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  };
  return visit(type, argumentsOf(checker, type));
}

/** The value `markedType` reads; a caller splits a union or intersection first. */
export function typeMarker(checker: ts.TypeChecker, type: ts.Type, role: string): string | undefined {
  return markedType(checker, type, role)?.value;
}
