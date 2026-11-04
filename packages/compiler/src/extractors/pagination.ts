import ts from 'typescript';
import type { PaginationParam, ParamEntry, RoutePagination } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import type { JsonSchema } from '../schema/derive.js';
import { isDeclaredIn } from '../schema/framework-members.js';
import { unwrapTransparent } from '../schema/wrappers.js';

const PAGE_KINDS = new Map<string, RoutePagination['kind']>([['Page', 'offset'], ['CursorPage', 'cursor']]);
const PAGE_NAMES: Record<RoutePagination['kind'], string[]> = { offset: ['page'], cursor: ['cursor', 'after'] };
const SIZE_NAMES = ['pageSize', 'perPage', 'limit'];

/** A route argument with its type as the class that serves the route sees it. */
interface TypedParam {
  entry: ParamEntry;
  type: ts.Type;
}

interface FoundParam extends PaginationParam {
  entry: ParamEntry;
}

const HTTP = '@spinajs/http';

interface FoundPage {
  kind: RoutePagination['kind'];
  item: ts.Type;
}

const inDefaultLib = (symbol: ts.Symbol): boolean => symbol.declarations?.[0]?.getSourceFile().hasNoDefaultLib === true;

/**
 * Nominal on purpose: the type literal the type was instantiated from must be the body of `Page` or `CursorPage` in
 * `@spinajs/http`, so a structurally equal type declared elsewhere is not a page. An app alias (`type UserPage =
 * Page<UserDto>`) renames `aliasSymbol` but keeps that declaration, which is why the alias name is not read.
 */
function itemOf(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): ts.Type | undefined {
  const items = checker.getPropertyOfType(type, 'items');
  const itemsType = items && checker.getTypeOfSymbolAtLocation(items, node);
  return itemsType && checker.isArrayType(itemsType) ? checker.getTypeArguments(itemsType as ts.TypeReference)[0] : undefined;
}

function declaredPage(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): FoundPage | undefined {
  const declaration = type.getSymbol()?.declarations?.[0];
  if (!declaration || !ts.isTypeLiteralNode(declaration) || !ts.isTypeAliasDeclaration(declaration.parent) || !isDeclaredIn(declaration, HTTP)) return undefined;
  const kind = PAGE_KINDS.get(declaration.parent.name.text);
  const item = itemOf(checker, type, node);
  return kind && item ? { kind, item } : undefined;
}

const isReference = (type: ts.Type): type is ts.TypeReference => (type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;

/**
 * An interface that extends a page (`interface UserPage extends Page<UserDto> {}`). The bases of a generic
 * interface are not instantiated, so the item is read from the type itself.
 */
function inheritedPage(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, depth: number): FoundPage | undefined {
  const declared = isReference(type) ? type.target : type;
  if (!declared.isClassOrInterface()) return undefined;
  for (const base of checker.getBaseTypes(declared)) {
    const found = pageIn(checker, base, node, depth + 1);
    const item = found && itemOf(checker, type, node);
    if (found && item) return { kind: found.kind, item };
  }
  return undefined;
}

/** A page, also under `Readonly<…>`, intersected with more fields, or as the base of an interface. */
function pageIn(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, depth = 0): FoundPage | undefined {
  if (depth > 4) return undefined;
  const readonlyOf = type.aliasSymbol?.name === 'Readonly' && inDefaultLib(type.aliasSymbol) ? type.aliasTypeArguments?.[0] : undefined;
  if (readonlyOf) return pageIn(checker, readonlyOf, node, depth + 1);
  if (type.isIntersection()) return type.types.reduce<FoundPage | undefined>((found, member) => found ?? pageIn(checker, member, node, depth + 1), undefined);
  return declaredPage(checker, type, node) ?? inheritedPage(checker, type, node, depth);
}

/**
 * `Page<T> | undefined` is one answer that may be empty, not a union of answers; `null` is a JSON reply of its own
 * and stays. `Ok<Page<T>> | undefined` stays a union: the reply schema is not derived through a wrapper in a union.
 */
function definedPayload(checker: ts.TypeChecker, returnType: ts.Type): ts.Type {
  const payload = unwrapTransparent(checker, returnType);
  if (!payload.isUnion()) return payload;
  const defined = payload.types.filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0);
  return defined.length === 1 && unwrapTransparent(checker, defined[0]) === defined[0] ? defined[0] : payload;
}

// One reply schema cannot describe several answers, so a union is not unwrapped (`wrapperName`) and not marked either.
const isUnionWithPage = (checker: ts.TypeChecker, payload: ts.Type, node: ts.Node): boolean =>
  payload.isUnion() && payload.types.some((member) => !!pageIn(checker, unwrapTransparent(checker, member), node));

/** A query value argument of that name, or the property of that name in a whole or JSON query object. */
function queryParamNamed(name: string, params: readonly TypedParam[], checker: ts.TypeChecker): FoundParam | undefined {
  for (const { entry, type } of params) {
    const { wire } = entry;
    if (wire?.in !== 'query') continue;
    if (wire.shape === 'value' && (wire.name ?? entry.name) === name) return { entry, arg: entry.name, path: [] };
    if ((wire.shape === 'whole' || wire.shape === 'json') && checker.getPropertyOfType(checker.getApparentType(type), name)) return { entry, arg: entry.name, path: [name] };
  }
  return undefined;
}

const firstFound = (names: readonly string[], params: readonly TypedParam[], checker: ts.TypeChecker): FoundParam | undefined =>
  names.reduce<FoundParam | undefined>((found, name) => found ?? queryParamNamed(name, params, checker), undefined);

const asObject = (value: unknown): JsonSchema | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : undefined);

function schemaById(id: string | undefined, ctx: ExtractorContext): JsonSchema | undefined {
  if (id === undefined) return undefined;
  return ctx.schemaRegistry.get(id) ?? asObject(ctx.schemas[id]);
}

/** The schema of `key` in an object schema, through `$ref` and `allOf` as the compiler derives an intersection. */
function propertySchema(schema: JsonSchema | undefined, key: string, ctx: ExtractorContext, depth = 0): JsonSchema | undefined {
  if (!schema || depth > 8) return undefined;
  const own = asObject(asObject(schema.properties)?.[key]);
  if (own) return own;
  const ref = typeof schema.$ref === 'string' ? schemaById(schema.$ref, ctx) : undefined;
  const parts = [ref, ...(Array.isArray(schema.allOf) ? schema.allOf.map(asObject) : [])];
  return parts.reduce<JsonSchema | undefined>((found, part) => found ?? propertySchema(part, key, ctx, depth + 1), undefined);
}

/** The lowest value the schema admits, through `$ref`; an `exclusiveMinimum` counts as the integer above it. */
function lowestOf(schema: JsonSchema | undefined, ctx: ExtractorContext, depth = 0): number | undefined {
  if (!schema || depth > 8) return undefined;
  const exclusive = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : undefined;
  const bounds = [schema.minimum, exclusive].filter((bound): bound is number => typeof bound === 'number');
  if (bounds.length > 0) return Math.max(...bounds);
  return typeof schema.$ref === 'string' ? lowestOf(schemaById(schema.$ref, ctx), ctx, depth + 1) : undefined;
}

/** `0` when the page parameter's schema starts at 0; any other start counts from 1. */
function firstPageOf(found: FoundParam, ctx: ExtractorContext): number {
  const { entry, path } = found;
  const root = schemaById(entry.schema, ctx) ?? schemaById(entry.runtimeType.schema, ctx);
  const at = path.reduce<JsonSchema | undefined>((schema, key) => propertySchema(schema, key, ctx), root);
  return lowestOf(at, ctx) === 0 ? 0 : 1;
}

const located = (found: FoundParam): PaginationParam => ({ arg: found.arg, path: found.path });

/** The route as doctor names it: the class that serves it and the handler. */
export interface PagedRoute {
  owner: string;
  handler: string;
}

/** `RouteEntry.pagination` for a route returning the `@spinajs/http` `Page<T>` or `CursorPage<T>`. */
export function paginationOf(returnType: ts.Type, params: readonly TypedParam[], node: ts.Node, route: PagedRoute, ctx: ExtractorContext): RoutePagination | undefined {
  const payload = definedPayload(ctx.checker, returnType);
  const page = pageIn(ctx.checker, payload, node);
  if (!page) {
    if (isUnionWithPage(ctx.checker, payload, node)) {
      const message = `${route.owner}.${route.handler} returns a page inside a union, which is not marked as paginated: the generated client gets no infinite query for it. Return the page type itself, and the other answers by throwing.`;
      ctx.warn('HTTP007', message, node);
    }
    return undefined;
  }
  const param = firstFound(PAGE_NAMES[page.kind], params, ctx.checker);
  const size = firstFound(SIZE_NAMES, params, ctx.checker);
  return {
    kind: page.kind,
    item: ctx.typeRef(page.item, node, `${route.owner}_${route.handler}_Item`),
    ...(param ? { param: located(param) } : {}),
    ...(size ? { size: located(size) } : {}),
    ...(param && page.kind === 'offset' ? { firstPage: firstPageOf(param, ctx) } : {}),
  };
}
