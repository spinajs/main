import ts from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ExtractorContext } from '../context.js';
import type { DecoratorInfo } from '../decorators.js';

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
