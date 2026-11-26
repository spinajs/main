import ts from 'typescript';
import type { GlobalMiddlewareRef, MiddlewareRef, PolicyRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, identifierName, literalValue, type DecoratorInfo, type LiteralContext } from '../decorators.js';
import { decoratorOrigin, originOf } from './decorator-origin.js';

const refOf = (expr: ts.Expression | undefined, ctx: ExtractorContext): string => {
  const value = identifierName(expr) ?? literalValue(expr, ctx);
  return typeof value === 'string' ? value : 'unknown';
};

interface AccessInfo {
  access?: string[];
  allowAnonymous?: boolean;
  also: string[];
  fieldsFilter: boolean;
  /** The options whose `fields` the build cannot read. */
  unreadFields: ts.Expression | undefined;
}

/** What `@Access` options do with `fields`; a value the build cannot read is `undefined`. */
type FieldsRead = { set: false } | { set: true; value: unknown };

const FIELDS_UNSET: FieldsRead = { set: false };
const FIELDS_UNREAD: FieldsRead = { set: true, value: undefined };

function initializerOf(symbol: ts.Symbol | undefined, ctx: LiteralContext): ts.Expression | undefined {
  const decl = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol).valueDeclaration;
  // a let or var may be reassigned before the decorator runs, so only a const is held to its initializer
  return decl && ts.isVariableDeclaration(decl) && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl.initializer : undefined;
}

/** The object literal `expr` is written as, through wrappers and constants. */
function objectLiteralOf(expr: ts.Expression, ctx: LiteralContext): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return objectLiteralOf(expr.expression, ctx);
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.freeze' && expr.arguments[0]) return objectLiteralOf(expr.arguments[0], ctx);
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  const initializer = initializerOf(ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name), ctx);
  return initializer && objectLiteralOf(initializer, ctx);
}

function memberFields(member: ts.ObjectLiteralElementLike, ctx: LiteralContext): FieldsRead {
  if (ts.isSpreadAssignment(member)) return fieldsOf(member.expression, ctx);
  const key = ts.isComputedPropertyName(member.name) ? literalValue(member.name.expression, ctx) : member.name.text;
  if (key !== 'fields') return typeof key === 'string' || typeof key === 'number' ? FIELDS_UNSET : FIELDS_UNREAD;
  if (ts.isPropertyAssignment(member)) return { set: true, value: literalValue(member.initializer, ctx) };
  // literalValue resolves a shorthand name to the property itself, not to the variable it copies
  if (ts.isShorthandPropertyAssignment(member)) {
    const initializer = initializerOf(ctx.checker.getShorthandAssignmentValueSymbol(member), ctx);
    return initializer ? { set: true, value: literalValue(initializer, ctx) } : FIELDS_UNREAD;
  }
  return FIELDS_UNREAD;
}

/** The last member that may set `fields` decides, as in the object the runtime receives; options the build cannot follow may set it. */
function fieldsOf(options: ts.Expression, ctx: LiteralContext): FieldsRead {
  const literal = objectLiteralOf(options, ctx);
  if (!literal) return FIELDS_UNREAD;
  for (const member of [...literal.properties].reverse()) {
    const read = memberFields(member, ctx);
    if (read.set) return read;
  }
  return FIELDS_UNSET;
}

type FieldsFilter = Pick<AccessInfo, 'fieldsFilter' | 'unreadFields'>;

/** A `fields` the build cannot read counts as filtering: a redacted reply must not be documented or cached as unredacted. */
function fieldsFilterOf(options: ts.Expression, ctx: ExtractorContext): FieldsFilter {
  const fields = fieldsOf(options, { checker: ctx.checker, info: () => undefined });
  if (fields.set && fields.value === undefined) return { fieldsFilter: true, unreadFields: options };
  return { fieldsFilter: fields.set && (fields.value === 'filter' || fields.value === 'filter-rows'), unreadFields: undefined };
}

function accessOptions(arg: ts.Expression | undefined, ctx: ExtractorContext): FieldsFilter & { also: string[] } {
  if (!arg) return { also: [], fieldsFilter: false, unreadFields: undefined };
  const fields = fieldsFilterOf(arg, ctx);
  if (!ts.isObjectLiteralExpression(arg)) return { also: [], ...fields };
  const alsoProp = arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'also');
  const also = alsoProp && ts.isArrayLiteralExpression(alsoProp.initializer) ? alsoProp.initializer.elements.map((e) => refOf(e, ctx)) : [];
  // read once with notes, as before: fieldsFilterOf reads quietly so that nothing is noted twice
  literalValue(arg, ctx);
  return { also, ...fields };
}

export function accessOf(node: ts.HasDecorators, ctx: ExtractorContext): AccessInfo {
  const info: AccessInfo = { also: [], fieldsFilter: false, unreadFields: undefined };
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

/**
 * The policy groups `node`'s transport mounts: each transport reads only its own descriptor, which only its own policy
 * decorator writes, and `@Access` writes http's.
 */
export function policyGroupsOf(node: ts.HasDecorators, ctx: ExtractorContext, scope: 'route' | 'class', transport: 'http' | 'socket'): PolicyRef[][] {
  const policyDecorator = transport === 'http' ? 'Policy' : 'SocketPolicy';
  const groups: PolicyRef[][] = [];
  for (const d of decoratorsOf(node)) {
    if (d.name !== policyDecorator) continue;
    const first = d.args[0];
    const members = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : first ? [first] : [];
    const options = d.args.slice(1).map((a) => literalValue(a, ctx));
    if (members.length) groups.push(members.map((m) => ({ type: refOf(m, ctx), options })));
  }
  if (transport === 'socket') return groups;
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
  TenantRoute: { package: '@spinajs/tenancy-http', type: 'TenantMiddleware' },
  NoTenant: { package: '@spinajs/tenancy-http', type: 'TenantMiddleware' },
  AllTenants: { package: '@spinajs/tenancy-http', type: 'TenantMiddleware' },
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

const DEFAULT_EXPORT: string = ts.InternalSymbolName.Default;

/** The declared name of the mounted class, as the factory decorators record it, so a name match also sees an import alias. */
function mountedTypeOf(expr: ts.Expression | undefined, ctx: ExtractorContext): string {
  const declared = originOf(expr, ctx)?.name;
  return declared && declared !== DEFAULT_EXPORT ? declared : refOf(expr, ctx);
}

interface DecoratedMiddleware {
  ref: MiddlewareRef;
  /** `@Idempotent` replaces a gate already mounted; `@Middleware(IdempotencyMiddleware, ...)` adds one. */
  replacesGate: boolean;
}

/**
 * Replays the decorators bottom-up, as the runtime applies them: `@Idempotent` replaces the first gate already mounted,
 * in place (http decorators.ts). So stacked ones leave one gate: the top one's arguments, where the bottom one mounted it.
 */
function asMounted(decorated: DecoratedMiddleware[]): MiddlewareRef[] {
  const gate = FACTORY_MIDDLEWARES.Idempotent.type;
  const mounted: MiddlewareRef[] = [];
  for (const { ref, replacesGate } of [...decorated].reverse()) {
    const at = replacesGate ? mounted.findIndex((m) => m.type === gate) : -1;
    if (at >= 0) mounted.splice(at, 1, ref);
    else mounted.push(ref);
  }
  return mounted.reverse();
}

/** In source order; see `MiddlewareRef`. */
export function middlewaresOf(node: ts.HasDecorators, ctx: ExtractorContext): MiddlewareRef[] {
  const decorated = decoratorsOf(node).flatMap((d): DecoratedMiddleware[] => {
    if (d.name === 'Middleware') {
      const type = mountedTypeOf(d.args[0], ctx);
      const options = literalArgs(d.args.slice(1), ctx);
      return [{ ref: options ? { type, options } : { type }, replacesGate: false }];
    }
    const factory = factoryMiddleware(d, ctx);
    return factory ? [{ ref: factory, replacesGate: factory.type === FACTORY_MIDDLEWARES.Idempotent.type }] : [];
  });
  const out = asMounted(decorated);
  const { fieldsFilter, unreadFields } = accessOf(node, ctx);
  // noted here, not in accessOf: middlewaresOf reads a node once, accessOf three times
  if (unreadFields) ctx.info('CMP001', `the fields option of @Access cannot be read (${unreadFields.getText()}): recorded as filtering, AUTHZ008 does not check this route`, unreadFields);
  if (fieldsFilter) out.push({ type: 'AuthzFieldsMiddleware', options: [] });
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
