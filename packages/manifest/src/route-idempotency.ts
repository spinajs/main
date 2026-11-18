import type { MiddlewareRef, RouteEntry } from './types.js';

export const IDEMPOTENCY_MIDDLEWARE = 'IdempotencyMiddleware';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `RouteEntry.idempotency` of a route with these middlewares, in source order. Of stacked `@Idempotent` the first counts:
 * decorators apply bottom-up, so the runtime keeps the top one. Options that are not a literal leave no `decoratorArgs`
 * and count as not required.
 */
export function idempotencyOf(middlewares: readonly MiddlewareRef[]): RouteEntry['idempotency'] {
  const gate = middlewares.find((m) => m.type === IDEMPOTENCY_MIDDLEWARE);
  if (!gate) return undefined;
  const options = gate.decoratorArgs?.[0];
  return { required: isObject(options) && options.required === true };
}
