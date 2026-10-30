import { isAbstractClass } from './abstract.js';
import ts from 'typescript';
import { configuredMountPath, controllerMountPath, routeFullPath, servedPath } from '@spinajs/manifest';
import type { ControllerEntry, ParamEntry, RouteEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';
import { accessOf, middlewaresOf, policyGroupsOf } from './policies.js';
import { routeDocOf } from './jsdoc.js';
import { conditionOf } from './conditions.js';
import { wireOf, type RouteWireContext } from './wire.js';
import { propertyInjectsOf } from './injections.js';

/** Parameter decorator -> the `ParameterType` (http) or route-arg type (orm-http) it registers; `ParamEntry.kind` records it. */
export const PARAM_KINDS: Record<string, string> = {
  FromDI: 'FromDi', BodyField: 'BodyFieldRouteArgs', AcceptType: 'RequestTypeRouteArgs', HeadersField: 'HeadersFieldRouteArgs',
  QueryField: 'QueryFieldRouteArgs', ParamField: 'ParamFieldRouteArgs', Query: 'FromQuery', Body: 'FromBody', Param: 'FromParams',
  Header: 'FromHeader', File: 'FromFile', Files: 'FromFile', CsvFile: 'FromCSV', JsonFile: 'FromJSONFile', Form: 'FromForm',
  FormField: 'FromFormField', Ip: 'IpRouteArgs', RequestId: 'RequestIdRouteArgs', UserAgent: 'UserAgentRouteArgs', Referer: 'RefererRouteArgs',
  RawBody: 'RawBodyRouteArgs', FromXml: 'FromXmlRouteArgs', PKey: 'FromParams', Uuid: 'FromParams', Req: 'ArgAsRequest', Res: 'ArgAsResponse', Model: 'FromModel',
  FromModel: 'FromDbModel', AsModel: 'AsDbModel', Cookie: 'FromCookie',
};
export const ROUTE_METHODS: Record<string, RouteEntry['method']> = { Get: 'get', Post: 'post', Put: 'put', Patch: 'patch', Del: 'delete', Head: 'head' };
const SCHEMA_ARG_INDEX: Record<string, number> = { Query: 0, Param: 0, Header: 1, FormField: 0 };
const BUILTIN_SCHEMAS: Record<string, unknown> = {
  PKey: { type: 'number', minimum: 0 },
  Uuid: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$' },
};
// Values the framework injects (or binary uploads): their types are not wire input, so nothing is derived from them.
const UNDERIVED_KINDS = new Set(['FromFile', 'ArgAsRequest', 'ArgAsResponse', 'FromDi']);
// Decorators whose first argument is neither the schema nor the options but still shapes the wire (header key, key location).
const WIRE_FIRST_ARG = new Set(['Header', 'PKey', 'Uuid']);
// `@PKey(type?)` / `@Uuid(type?)` register under the ParameterType given as their first argument.
const TYPED_BY_FIRST_ARG = new Set(['PKey', 'Uuid']);
const OPTIONS_ARG_INDEX: Record<string, number> = { Query: 1, Param: 1, Header: 2, FormField: 1, Body: 0, File: 0, Files: 0, Form: 0, JsonFile: 0, CsvFile: 0, FromXml: 0, Model: 0, FromModel: 0, AsModel: 0 };

type NamedClass = ts.ClassDeclaration & { name: ts.Identifier };

function isRequired(p: ts.ParameterDeclaration, type: ts.Type): boolean {
  if (p.questionToken || p.initializer) return false;
  const members = type.isUnion() ? type.types : [type];
  return !members.some((t) => t.flags & ts.TypeFlags.Undefined);
}

const paramDecoratorOf = (p: ts.ParameterDeclaration): DecoratorInfo | undefined => decoratorsOf(p).find((d) => PARAM_KINDS[d.name]);

/** The `ParameterType` the runtime registers the argument under, which route-args such as `FromBody` count. */
function parameterTypeOf(dec: DecoratorInfo, ctx: ExtractorContext): string {
  const given = TYPED_BY_FIRST_ARG.has(dec.name) ? literalValue(dec.args[0], ctx) : undefined;
  return typeof given === 'string' && given !== '' ? given : PARAM_KINDS[dec.name];
}

/** The decorator argument that shapes the wire besides the type: the options object, the header key or the key location. */
function firstArgOf(dec: DecoratorInfo, options: unknown, ctx: ExtractorContext): unknown {
  if (OPTIONS_ARG_INDEX[dec.name] === 0) return options;
  return WIRE_FIRST_ARG.has(dec.name) ? literalValue(dec.args[0], ctx) : undefined;
}

function paramOf(p: ts.ParameterDeclaration, index: number, owner: string, route: RouteWireContext, ctx: ExtractorContext): ParamEntry | undefined {
  const dec = paramDecoratorOf(p);
  if (!dec) return undefined;
  const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
  const optionsIdx = OPTIONS_ARG_INDEX[dec.name];
  const options = literalValue(optionsIdx !== undefined ? dec.args[optionsIdx] : undefined, ctx) as { required?: boolean } | undefined;
  const schemaIdx = SCHEMA_ARG_INDEX[dec.name];
  const schema = BUILTIN_SCHEMAS[dec.name] ?? literalValue(schemaIdx !== undefined ? dec.args[schemaIdx] : undefined, ctx);
  let schemaId: string | undefined;
  if (schema !== undefined && schema !== null) {
    schemaId = `spinajs/${ctx.packageName}/${owner}.${name}`;
    ctx.schemas[schemaId] = schema;
  }
  const type = ctx.checker.getTypeAtLocation(p);
  const kind = parameterTypeOf(dec, ctx);
  const nonNull = ctx.checker.getNonNullableType(type);
  const runtimeType = UNDERIVED_KINDS.has(kind) ? ctx.plainTypeRef(nonNull) : ctx.typeRef(nonNull, p, `${owner.replace('.', '_')}_${name}`);
  const ref = ctx.runtimeRef(type, p);
  return {
    index, name, kind, runtimeType: ref ? { ...runtimeType, ref } : runtimeType,
    required: options?.required === true || isRequired(p, type),
    ...(options !== undefined ? { options } : {}), ...(schemaId ? { schema: schemaId } : {}),
    wire: wireOf({ dec, firstArg: firstArgOf(dec, options, ctx), p, name, type, route, ctx }),
  };
}

function routeOf(m: ts.MethodDeclaration, mountPath: string, className: string, ctx: ExtractorContext): RouteEntry | undefined {
  const dec = decoratorsOf(m).find((d) => ROUTE_METHODS[d.name]);
  if (!dec || !ts.isIdentifier(m.name)) return undefined;
  const handler = m.name.text;
  const path = (literalValue(dec.args[0], ctx) as string | undefined) ?? '';
  const sig = ctx.checker.getSignatureFromDeclaration(m);
  const returnType = sig ? ctx.typeRef(ctx.checker.getReturnTypeOfSignature(sig), m, `${className}_${handler}_Response`) : { text: 'unknown' };
  const { access, allowAnonymous } = accessOf(m, ctx);
  const doc = routeDocOf(m, ctx);
  const types = m.parameters.map((p) => paramDecoratorOf(p)).map((d) => (d ? parameterTypeOf(d, ctx) : undefined));
  const countOf = (type: string): number => types.filter((t) => t === type).length;
  const fullPath = servedPath(routeFullPath(mountPath, path, handler));
  const placeholders = new Set([...fullPath.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const wire: RouteWireContext = { bodyParams: countOf('FromBody'), asModelParams: countOf('AsDbModel'), placeholders };
  return {
    method: ROUTE_METHODS[dec.name], path, handler, fullPath,
    params: m.parameters.map((p, i) => paramOf(p, i, `${className}.${handler}`, wire, ctx)).filter((p): p is ParamEntry => !!p),
    returnType, policies: policyGroupsOf(m, ctx, 'route'), middlewares: middlewaresOf(m, ctx),
    ...(access ? { access } : {}), ...(allowAnonymous ? { allowAnonymous } : {}), ...(doc ? { doc } : {}),
    source: ctx.sourceRef(m),
  };
}

function controllerOf(node: NamedClass, ctx: ExtractorContext): ControllerEntry {
  const bp = findDecorator(node, 'BasePath');
  const bpValue = literalValue(bp?.args[0], ctx) as string | { config: string; default: string } | undefined;
  const basePath = typeof bpValue === 'string' ? bpValue : bpValue?.default ?? null;
  const basePathConfig = typeof bpValue === 'object' && bpValue ? bpValue.config : undefined;
  const mountPath = basePathConfig && basePath ? configuredMountPath(basePath) : controllerMountPath(basePath, node.name.text);
  const { access, allowAnonymous } = accessOf(node, ctx);
  const condition = conditionOf(node, ctx);
  const propertyInjects = propertyInjectsOf(node, ctx);
  return {
    id: `${ctx.packageName}:${node.name.text}`, className: node.name.text, basePath, ...(basePathConfig ? { basePathConfig } : {}), mountPath,
    policies: policyGroupsOf(node, ctx, 'class'), middlewares: middlewaresOf(node, ctx),
    ...(access ? { access } : {}), ...(allowAnonymous ? { allowAnonymous } : {}),
    routes: node.members.filter(ts.isMethodDeclaration).map((m) => routeOf(m, mountPath, node.name.text, ctx)).filter((r): r is RouteEntry => !!r),
    ...(propertyInjects.length ? { propertyInjects } : {}),
    ...(condition ? { condition } : {}), source: ctx.sourceRef(node),
  };
}

export const extractControllers: Extractor<ControllerEntry> = (ctx, file) => {
  const out: ControllerEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && !isAbstractClass(node)) {
      const hasRoute = node.members.some((m) => ts.isMethodDeclaration(m) && decoratorsOf(m).some((d) => ROUTE_METHODS[d.name]));
      if (hasRoute || ctx.isSubclassOf(node, 'BaseController')) out.push(controllerOf(node as NamedClass, ctx));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
