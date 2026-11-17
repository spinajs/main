import ts from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, type DecoratorInfo } from '../decorators.js';
import { declaringPackage, isDeclaredIn } from '../schema/framework-members.js';

const packageNames = new Map<string, string | undefined>();

function packageNameOf(dir: string): string | undefined {
  if (packageNames.has(dir)) return packageNames.get(dir);
  const manifest = join(dir, 'package.json');
  let name: string | undefined;
  if (existsSync(manifest)) name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
  else if (dirname(dir) !== dir) name = packageNameOf(dirname(dir));
  packageNames.set(dir, name);
  return name;
}

const programPackages = new WeakMap<ts.Program, Set<string | undefined>>();

/**
 * A file of the program belongs to `packageName`. Without one, no symbol can resolve to that package, under any alias or
 * re-export. Both resolvers count, so the gate is never stricter than the `isDeclaredIn` checks it guards.
 */
export function programDeclares(program: ts.Program, packageName: string): boolean {
  let names = programPackages.get(program);
  if (!names) {
    names = new Set(program.getSourceFiles().flatMap((f) => [packageNameOf(dirname(f.fileName)), declaringPackage(f)]));
    programPackages.set(program, names);
  }
  return names.has(packageName);
}

/** The declared name of the function a decorator calls, whatever name it is imported under, and the package that declares it. */
export function decoratorOrigin(decorator: DecoratorInfo, ctx: ExtractorContext): { name: string; package?: string } | undefined {
  const expr = decorator.node.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = ctx.checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) return undefined;
  return { name: symbol.name, package: packageNameOf(dirname(declaration.getSourceFile().fileName)) };
}

/** The first decorator of `node` that `packageName` declares under one of `names`, whatever name it is imported under. */
export function declaredDecorator<N extends string>(node: ts.HasDecorators, packageName: string, names: readonly N[], ctx: ExtractorContext): { name: N; decorator: DecoratorInfo } | undefined {
  for (const decorator of decoratorsOf(node)) {
    const origin = decoratorOrigin(decorator, ctx);
    const name = origin?.package === packageName ? names.find((n) => n === origin.name) : undefined;
    if (name !== undefined) return { name, decorator };
  }
  return undefined;
}

/** `callee` names the function `name` that `packageName` declares, under an import alias too; a member access counts only under that name. */
export function isFunctionOf(callee: ts.Expression, name: string, packageName: string, checker: ts.TypeChecker): boolean {
  const member = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && callee.name.text === name ? callee.name : undefined;
  const id = ts.isIdentifier(callee) ? callee : member;
  if (!id) return false;
  let symbol = checker.getSymbolAtLocation(id);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.name === name && isDeclaredIn(symbol.valueDeclaration ?? symbol.declarations?.[0], packageName);
}
