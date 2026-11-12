import type ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, literalValue } from '../decorators.js';
import { decoratorOrigin } from './decorator-origin.js';

const HTTP_PACKAGE = '@spinajs/http';

function httpDecoratorOf(node: ts.HasDecorators, name: string, ctx: ExtractorContext) {
  return decoratorsOf(node).find((d) => {
    const origin = decoratorOrigin(d, ctx);
    return origin?.name === name && origin.package === HTTP_PACKAGE;
  });
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
