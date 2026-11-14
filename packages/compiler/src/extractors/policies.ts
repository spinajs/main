import ts from 'typescript';
import type { GlobalMiddlewareRef, MiddlewareRef, PolicyRef } from '@spinajs/manifest';
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
  /** Indexes of the decorator arguments recorded as `decoratorArgs`; all of them when absent. */
  args?: number[];
}

/**
 * Decorators that mount a route middleware through `Middleware(Type, ...)`, by their declared name. A decorator counts only
 * when it resolves to the package listed, so an app's own `@Deprecated` is not taken for the framework one. The recorded
 * `decoratorArgs` are the decorator's own arguments, not the constructor options it derives from them.
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
  // `answer` (index 1) is a function, never a literal: skipping it keeps the flow and mode and spares a CMP001 note
  IpThrottle: { package: '@spinajs/authn-http', type: 'AuthnIpThrottleMiddleware', args: [0, 2] },
};

/** The decorator names that mount a middleware, as declared; an import alias of one is not listed. */
export const MIDDLEWARE_DECORATORS: readonly string[] = ['Middleware', ...Object.keys(FACTORY_MIDDLEWARES)];

function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(isPlainJson);
  return false;
}

/** The literal values of `args`, or nothing when one of them is not plain JSON in the source. */
function literalArgs(args: readonly ts.Expression[], ctx: ExtractorContext): unknown[] | undefined {
  const values = args.map((a) => literalValue(a, ctx));
  return values.every(isPlainJson) ? values : undefined;
}

function factoryMiddleware(d: DecoratorInfo, ctx: ExtractorContext): MiddlewareRef | undefined {
  const origin = decoratorOrigin(d, ctx);
  const factory = origin && Object.hasOwn(FACTORY_MIDDLEWARES, origin.name) ? FACTORY_MIDDLEWARES[origin.name] : undefined;
  if (!factory || factory.package !== origin?.package) return undefined;
  const decoratorArgs = literalArgs(factory.args ? factory.args.filter((i) => i < d.args.length).map((i) => d.args[i]) : d.args, ctx);
  return decoratorArgs ? { type: factory.type, decoratorArgs } : { type: factory.type };
}

/** In source order; see `MiddlewareRef`. */
export function middlewaresOf(node: ts.HasDecorators, ctx: ExtractorContext): MiddlewareRef[] {
  const out = decoratorsOf(node).flatMap((d): MiddlewareRef[] => {
    if (d.name === 'Middleware') {
      const type = refOf(d.args[0], ctx);
      const options = literalArgs(d.args.slice(1), ctx);
      return [options ? { type, options } : { type }];
    }
    const factory = factoryMiddleware(d, ctx);
    return factory ? [factory] : [];
  });
  if (accessOf(node, ctx).fieldsFilter) out.push({ type: 'AuthzFieldsMiddleware', options: [] });
  return out;
}

/**
 * `http.routes.middlewares` as the runtime reads it: a name, a class, or `{ service, options }`, recorded by type name only.
 * Options are config values, which may hold secrets or objects that do not serialize. An entry the runtime refuses is left
 * out; `spinajs doctor` (CFG004) reports a name nothing registers.
 */
export function globalRouteMiddlewaresOf(entries: unknown): GlobalMiddlewareRef[] {
  if (!Array.isArray(entries)) return [];
  const ref = (service: unknown): GlobalMiddlewareRef | undefined => {
    if (typeof service === 'string') return { type: service };
    return typeof service === 'function' && service.name ? { type: service.name, fromClass: true } : undefined;
  };
  return entries.flatMap((entry: unknown) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const { service, options } = entry as { service?: unknown; options?: unknown };
      const found = ref(service);
      return found && (options === undefined || Array.isArray(options)) ? [found] : [];
    }
    const found = ref(entry);
    return found ? [found] : [];
  });
}
