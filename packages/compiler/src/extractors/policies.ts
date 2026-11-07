import ts from 'typescript';
import type { PolicyRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, identifierName, literalValue, type DecoratorInfo } from '../decorators.js';
import { decoratorOrigin } from './decorator-origin.js';

const refOf = (expr: ts.Expression | undefined, ctx: ExtractorContext): string => {
  const value = identifierName(expr) ?? literalValue(expr, ctx);
  return typeof value === 'string' ? value : 'unknown';
};

interface AccessInfo {
  access?: string[];
  allowAnonymous?: boolean;
  also: string[];
  fieldsFilter: boolean;
}

function accessOptions(arg: ts.Expression | undefined, ctx: ExtractorContext): { also: string[]; fieldsFilter: boolean } {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { also: [], fieldsFilter: false };
  const alsoProp = arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'also');
  const also = alsoProp && ts.isArrayLiteralExpression(alsoProp.initializer) ? alsoProp.initializer.elements.map((e) => refOf(e, ctx)) : [];
  const fields = (literalValue(arg, ctx) as { fields?: string } | undefined)?.fields;
  const fieldsFilter = fields === 'filter' || fields === 'filter-rows';
  return { also, fieldsFilter };
}

export function accessOf(node: ts.HasDecorators, ctx: ExtractorContext): AccessInfo {
  const info: AccessInfo = { also: [], fieldsFilter: false };
  for (const d of decoratorsOf(node)) {
    if (d.name === 'Access') {
      const first = literalValue(d.args[0], ctx);
      info.access = Array.isArray(first) ? first.map(String) : [String(first)];
      Object.assign(info, accessOptions(d.args[1], ctx));
    }
    if (d.name === 'AllowAnonymous') info.allowAnonymous = true;
  }
  return info;
}

export function policyGroupsOf(node: ts.HasDecorators, ctx: ExtractorContext, scope: 'route' | 'class'): PolicyRef[][] {
  const groups: PolicyRef[][] = [];
  for (const d of decoratorsOf(node)) {
    if (d.name !== 'Policy' && d.name !== 'SocketPolicy') continue;
    const first = d.args[0];
    const members = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : first ? [first] : [];
    const options = d.args.slice(1).map((a) => literalValue(a, ctx));
    if (members.length) groups.push(members.map((m) => ({ type: refOf(m, ctx), options })));
  }
  const { access, also } = accessOf(node, ctx);
  if (access) groups.push([{ type: 'AccessPolicy', options: [scope] }, ...also.map((type) => ({ type, options: [] as unknown[] }))]);
  return groups;
}

export interface FactoryMiddleware {
  package: string;
  type: string;
  /** Indexes of the decorator arguments passed on as middleware options; all of them when absent. */
  args?: number[];
}

/**
 * Decorators that mount a route middleware through `Middleware(Type, ...options)`, by their declared name. A decorator counts
 * only when it resolves to the package listed, so an app's own `@Deprecated` is not taken for the framework one.
 */
export const FACTORY_MIDDLEWARES: Readonly<Record<string, FactoryMiddleware>> = {
  Accepts: { package: '@spinajs/http', type: 'AcceptsMiddleware' },
  BotCheck: { package: '@spinajs/http', type: 'BotCheckMiddleware' },
  Idempotent: { package: '@spinajs/http', type: 'IdempotencyMiddleware' },
  Deprecated: { package: '@spinajs/http', type: 'DeprecationMiddleware' },
  Consumes: { package: '@spinajs/http', type: 'ConsumesMiddleware' },
  NoCompression: { package: '@spinajs/http', type: 'NoCompressionMiddleware' },
  RateLimit: { package: '@spinajs/http', type: 'RateLimitMiddleware' },
  Deadline: { package: '@spinajs/http', type: 'DeadlineMiddleware' },
  SlowThreshold: { package: '@spinajs/http', type: 'SlowThresholdMiddleware' },
  Unscoped: { package: '@spinajs/authz-http', type: 'UnscopedMiddleware' },
  // the second argument is the answer function, which goes to @OnError, not to the middleware
  IpThrottle: { package: '@spinajs/authn-http', type: 'AuthnIpThrottleMiddleware', args: [0, 2] },
};

/** The decorator names that mount a middleware, as declared; an import alias of one is not listed. */
export const MIDDLEWARE_DECORATORS: readonly string[] = ['Middleware', ...Object.keys(FACTORY_MIDDLEWARES)];

function factoryMiddleware(d: DecoratorInfo, ctx: ExtractorContext): { type: string; options: unknown[] } | undefined {
  const origin = decoratorOrigin(d, ctx);
  const factory = origin && Object.hasOwn(FACTORY_MIDDLEWARES, origin.name) ? FACTORY_MIDDLEWARES[origin.name] : undefined;
  if (!factory || factory.package !== origin?.package) return undefined;
  const args = factory.args ? factory.args.filter((i) => i < d.args.length).map((i) => d.args[i]) : d.args;
  return { type: factory.type, options: args.map((a) => literalValue(a, ctx)) };
}

export function middlewaresOf(node: ts.HasDecorators, ctx: ExtractorContext): { type: string; options?: unknown[] }[] {
  const out = decoratorsOf(node).flatMap((d) => {
    if (d.name === 'Middleware') return [{ type: refOf(d.args[0], ctx), options: d.args.slice(1).map((a) => literalValue(a, ctx)) }];
    const factory = factoryMiddleware(d, ctx);
    return factory ? [factory] : [];
  });
  if (accessOf(node, ctx).fieldsFilter) out.push({ type: 'AuthzFieldsMiddleware', options: [] });
  return out;
}

/**
 * `http.routes.middlewares` as the runtime reads it, by type name: a name, a class, or `{ service, options }`. An entry the
 * runtime refuses is left out; `spinajs doctor` (CFG004) reports a name nothing registers.
 */
export function globalRouteMiddlewaresOf(entries: unknown): { type: string; options?: unknown[] }[] {
  if (!Array.isArray(entries)) return [];
  const typeName = (service: unknown): string | undefined => (typeof service === 'string' ? service : typeof service === 'function' && service.name ? service.name : undefined);
  return entries.flatMap((entry: unknown) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const { service, options } = entry as { service?: unknown; options?: unknown };
      const type = typeName(service);
      if (!type || (options !== undefined && !Array.isArray(options))) return [];
      return [options === undefined ? { type } : { type, options: options as unknown[] }];
    }
    const type = typeName(entry);
    return type ? [{ type }] : [];
  });
}
