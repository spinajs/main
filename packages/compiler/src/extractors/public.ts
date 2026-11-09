import type ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, literalValue } from '../decorators.js';
import { decoratorOrigin } from './decorator-origin.js';

const HTTP_PACKAGE = '@spinajs/http';

/** The reason given to `@Public(reason)` on the class or method, if the decorator is the one from `@spinajs/http`. */
export function publicOf(node: ts.HasDecorators, ctx: ExtractorContext): string | undefined {
  const decorator = decoratorsOf(node).find((d) => {
    const origin = decoratorOrigin(d, ctx);
    return origin?.name === 'Public' && origin.package === HTTP_PACKAGE;
  });
  if (!decorator) return undefined;
  const reason = literalValue(decorator.args[0], ctx);
  return typeof reason === 'string' ? reason : 'unknown';
}
