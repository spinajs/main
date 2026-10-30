import ts from 'typescript';
import type { ParamWire, WireLocation } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';

/** Counts the route arguments whose binding depends on their siblings (`FromBody`, `AsDbModel`). */
export interface RouteWireContext {
  bodyParams: number;
  asModelParams: number;
}

const FIXED: Record<string, ParamWire> = {
  QueryField: { in: 'query', shape: 'whole' },
  ParamField: { in: 'path', shape: 'whole' },
  HeadersField: { in: 'header', shape: 'whole' },
  BodyField: { in: 'body', shape: 'whole' },
  RawBody: { in: 'body', shape: 'whole' },
  FromXml: { in: 'body', shape: 'whole' },
  Form: { in: 'multipart', shape: 'whole' },
};

// Injected by the framework or set by the user agent (Accept, User-Agent, Referer), never part of a call's input.
// `@Model` has no registered handler at all.
const NOT_SENT = new Set(['FromDI', 'Req', 'Res', 'Ip', 'RequestId', 'UserAgent', 'Referer', 'AcceptType', 'Model']);

const BY_PARAMETER_TYPE: Record<string, WireLocation> = { FromQuery: 'query', FromParams: 'path', FromHeader: 'header', FromBody: 'body', FromCookie: 'cookie' };

type Family = 'string' | 'number' | 'boolean' | 'bigint';

function familyOf(t: ts.Type): Family | undefined {
  if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.StringMapping)) return 'string';
  if (t.flags & ts.TypeFlags.NumberLike) return 'number';
  if (t.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  if (t.flags & ts.TypeFlags.BigIntLike) return 'bigint';
  return undefined;
}

/**
 * Mirrors the `design:type` TypeScript emits and `RouteArgs.tryHydrateParam` converts: a union of one primitive
 * family (literals and enums included, null/undefined ignored) becomes `String`/`Number`/`Boolean`/`BigInt` and is
 * read as a plain string; anything else is `Object`, `Array` or a class and is `JSON.parse`d.
 */
export function isScalarType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const t = checker.getNonNullableType(type);
  if (t.flags & ts.TypeFlags.Never) return true;
  const families = new Set((t.isUnion() ? t.types : [t]).map(familyOf));
  return families.size === 1 && !families.has(undefined);
}

function hydratedBy(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  if (!symbol) return undefined;
  for (const decl of symbol.declarations ?? []) {
    if (symbol.name === 'DateTime' && /[\\/]luxon[\\/]/.test(decl.getSourceFile().fileName)) return 'DateTimeHydrator';
    if (ts.isClassDeclaration(decl)) {
      const hydrator = findDecorator(decl, 'Hydrator');
      if (hydrator) return hydrator.args[0]?.getText() ?? 'Hydrator';
    }
  }
  return undefined;
}

/** `value` or `json` for a parameter read from one string (query key, url segment, header, cookie, form field). */
function stringShape(type: ts.Type, p: ts.ParameterDeclaration, ctx: ExtractorContext): 'value' | 'json' {
  if (isScalarType(type, ctx.checker)) return 'value';
  const hydrator = hydratedBy(ctx.checker.getNonNullableType(type));
  if (hydrator === 'DateTimeHydrator') return 'value';
  if (hydrator) {
    ctx.info('CMP005', `${p.name.getText()} is converted by ${hydrator}, which receives the raw string; the manifest records it as a plain value`, p);
    return 'value';
  }
  return 'json';
}

interface WireInput {
  dec: DecoratorInfo;
  firstArg: unknown;
  p: ts.ParameterDeclaration;
  name: string;
  type: ts.Type;
  route: RouteWireContext;
  ctx: ExtractorContext;
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** One key in a location; in the body that is `body[key]`. Node lower-cases header names. */
function keyed(location: WireLocation, key: string, shape: () => 'value' | 'json'): ParamWire {
  if (location === 'body') return { in: 'body', name: key, shape: 'field' };
  return { in: location, name: location === 'header' ? key.toLowerCase() : key, shape: shape() };
}

const fromString =
  (location: WireLocation) =>
  (i: WireInput): ParamWire =>
    keyed(location, i.name, () => stringShape(i.type, i.p, i.ctx));

/** `@PKey(ParameterType.FromQuery)` / `@Uuid(...)` read the key from another place than the url. */
const primaryKey = (i: WireInput): ParamWire => fromString(BY_PARAMETER_TYPE[nonEmpty(i.firstArg) ?? ''] ?? 'path')(i);

const file = (i: WireInput): ParamWire => ({ in: 'multipart', name: i.name, shape: 'value' });

function fromModel(i: WireInput): ParamWire {
  const options = i.firstArg as { paramType?: string; paramField?: string } | undefined;
  return keyed(BY_PARAMETER_TYPE[options?.paramType ?? ''] ?? 'path', options?.paramField ?? i.name, () => 'value');
}

function asModel(i: WireInput): ParamWire {
  const field = nonEmpty(i.firstArg);
  const location = BY_PARAMETER_TYPE[nonEmpty(literalValue(i.dec.args[1], i.ctx)) ?? ''] ?? 'body';
  if (location === 'body' && !field && i.route.asModelParams === 1) return { in: 'body', shape: 'whole' };
  return keyed(location, field ?? i.name, () => 'json');
}

const RULES: Record<string, (i: WireInput) => ParamWire> = {
  Query: fromString('query'),
  Param: fromString('path'),
  Cookie: fromString('cookie'),
  PKey: primaryKey,
  Uuid: primaryKey,
  Header: (i) => keyed('header', nonEmpty(i.firstArg) ?? i.name, () => stringShape(i.type, i.p, i.ctx)),
  Body: (i) => (i.route.bodyParams === 1 && !isScalarType(i.type, i.ctx.checker) ? { in: 'body', shape: 'whole' } : { in: 'body', name: i.name, shape: 'field' }),
  File: file,
  CsvFile: file,
  JsonFile: file,
  Files: (i) => ({ ...file(i), multiple: true }),
  FormField: (i) => (i.ctx.checker.isArrayType(i.ctx.checker.getNonNullableType(i.type)) ? { ...file(i), multiple: true } : fromString('multipart')(i)),
  FromModel: fromModel,
  AsModel: asModel,
};

/**
 * Where and how the value of one route argument travels, per the `@spinajs/http` route-args that read it.
 * `firstArg` is the decorator's first argument, already evaluated by the caller.
 */
export function wireOf(dec: DecoratorInfo, firstArg: unknown, p: ts.ParameterDeclaration, name: string, type: ts.Type, route: RouteWireContext, ctx: ExtractorContext): ParamWire {
  const fixed = FIXED[dec.name];
  if (fixed) return { ...fixed };
  const rule = NOT_SENT.has(dec.name) ? undefined : RULES[dec.name];
  return rule ? rule({ dec, firstArg, p, name, type, route, ctx }) : { in: 'none', shape: 'whole' };
}
