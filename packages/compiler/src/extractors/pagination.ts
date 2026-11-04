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

/** Nominal on purpose: a structurally equal type declared outside `@spinajs/http` is not a page. */
function pageOf(checker: ts.TypeChecker, returnType: ts.Type): { kind: RoutePagination['kind']; item: ts.Type } | undefined {
  const payload = unwrapTransparent(checker, returnType);
  const alias = payload.aliasSymbol;
  const kind = alias && PAGE_KINDS.get(alias.name);
  const item = payload.aliasTypeArguments?.[0];
  if (!kind || !item || !isDeclaredIn(alias.declarations?.[0], '@spinajs/http')) return undefined;
  return { kind, item };
}

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

/** `0` when the page parameter's schema starts at `minimum: 0`; any other start counts from 1. */
function firstPageOf(found: FoundParam, ctx: ExtractorContext): number {
  const { entry, path } = found;
  const root = schemaById(entry.schema, ctx) ?? schemaById(entry.runtimeType.schema, ctx);
  const at = path.reduce<JsonSchema | undefined>((schema, key) => propertySchema(schema, key, ctx), root);
  return at?.minimum === 0 ? 0 : 1;
}

const located = (found: FoundParam): PaginationParam => ({ arg: found.arg, path: found.path });

/** `RouteEntry.pagination` for a route returning the `@spinajs/http` `Page<T>` or `CursorPage<T>`. */
export function paginationOf(returnType: ts.Type, params: readonly TypedParam[], node: ts.Node, nameHint: string, ctx: ExtractorContext): RoutePagination | undefined {
  const page = pageOf(ctx.checker, returnType);
  if (!page) return undefined;
  const param = firstFound(PAGE_NAMES[page.kind], params, ctx.checker);
  const size = firstFound(SIZE_NAMES, params, ctx.checker);
  return {
    kind: page.kind,
    item: ctx.typeRef(page.item, node, `${nameHint}_Item`),
    ...(param ? { param: located(param) } : {}),
    ...(size ? { size: located(size) } : {}),
    ...(param && page.kind === 'offset' ? { firstPage: firstPageOf(param, ctx) } : {}),
  };
}
