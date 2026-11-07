import ts from 'typescript';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, literalValue } from '../decorators.js';

const HTTP_PACKAGE = '@spinajs/http';
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

/** The decorator is `name` of `@spinajs/http`, whatever name it is imported under; a same-named local function is not. */
function isHttpDecorator(callee: ts.Expression, name: string, ctx: ExtractorContext): boolean {
  const id = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = ctx.checker.getSymbolAtLocation(id);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  return symbol?.name === name && !!declaration && packageNameOf(dirname(declaration.getSourceFile().fileName)) === HTTP_PACKAGE;
}

function httpDecoratorOf(node: ts.HasDecorators, name: string, ctx: ExtractorContext) {
  return decoratorsOf(node).find((d) => isHttpDecorator(ts.isCallExpression(d.node.expression) ? d.node.expression.expression : d.node.expression, name, ctx));
}

/** The reason given to `@Public(reason)` on the class or method, if the decorator is the one from `@spinajs/http`. */
export function publicOf(node: ts.HasDecorators, ctx: ExtractorContext): string | undefined {
  const decorator = httpDecoratorOf(node, 'Public', ctx);
  if (!decorator) return undefined;
  const reason = literalValue(decorator.args[0], ctx);
  return typeof reason === 'string' ? reason : 'unknown';
}

/** Whether the class or method carries `@Deprecated()` of `@spinajs/http`. */
export function isDeprecated(node: ts.HasDecorators, ctx: ExtractorContext): boolean {
  return httpDecoratorOf(node, 'Deprecated', ctx) !== undefined;
}
