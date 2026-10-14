import ts from 'typescript';

const ACCESS_RESOURCE = 'AccessResource';
const PRIMARY = 'Primary';

function decoratorName(decorator: ts.Decorator, checker: ts.TypeChecker): string | undefined {
  const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  const named = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(named);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.name ?? (ts.isIdentifier(named) ? named.text : undefined);
}

const decoratorsOf = (node: ts.Node): readonly ts.Decorator[] => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);

function classDeclarations(symbol: ts.Symbol): ts.ClassLikeDeclaration[] {
  return (symbol.declarations ?? []).filter((d): d is ts.ClassLikeDeclaration => ts.isClassDeclaration(d) || ts.isClassExpression(d));
}

function resolve(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function baseOf(declaration: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.Symbol | undefined {
  const base = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  return base ? (checker.getTypeAtLocation(base.expression).getSymbol() ?? checker.getSymbolAtLocation(base.expression)) : undefined;
}

/**
 * Whether `symbol` is a class decorated with `@AccessResource`, or extends one. A class known only from a
 * `.d.ts` has lost its decorators, so it counts only when its name is in `extra`.
 */
export function isAccessResourceClass(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, extra: ReadonlySet<string>, cache: Map<ts.Symbol, boolean>): boolean {
  if (!symbol) return false;
  symbol = resolve(symbol, checker);
  const known = cache.get(symbol);
  if (known !== undefined) return known;
  // Provisional answer, so an inheritance cycle in a broken program ends.
  cache.set(symbol, false);

  let result = extra.has(symbol.name);
  for (const declaration of classDeclarations(symbol)) {
    if (result) break;
    result = decoratorsOf(declaration).some((d) => decoratorName(d, checker) === ACCESS_RESOURCE);
    if (!result) result = isAccessResourceClass(baseOf(declaration, checker), checker, extra, cache);
  }

  cache.set(symbol, result);
  return result;
}

/** The property decorated with `@Primary()` on the class or a class it extends; undefined when none is visible (a `.d.ts` base). */
export function primaryKeyOf(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, seen: Set<ts.Symbol> = new Set()): string | undefined {
  if (!symbol) return undefined;
  symbol = resolve(symbol, checker);
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);

  for (const declaration of classDeclarations(symbol)) {
    for (const member of declaration.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && decoratorsOf(member).some((d) => decoratorName(d, checker) === PRIMARY)) return member.name.text;
    }
    const inherited = primaryKeyOf(baseOf(declaration, checker), checker, seen);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}
