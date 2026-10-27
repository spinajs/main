import ts from 'typescript';
import type { ControllerEntry, ParamEntry, RouteEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, literalValue } from '../decorators.js';
import { accessOf, middlewaresOf, policyGroupsOf } from './policies.js';
import { routeDocOf } from './jsdoc.js';
import { conditionOf } from './conditions.js';

export const PARAM_KINDS: Record<string, string> = {
  FromDI: 'FromDi', BodyField: 'BodyFieldRouteArgs', AcceptType: 'RequestTypeRouteArgs', HeadersField: 'HeadersFieldRouteArgs',
  QueryField: 'QueryFieldRouteArgs', ParamField: 'ParamFieldRouteArgs', Query: 'FromQuery', Body: 'FromBody', Param: 'FromParams',
  Header: 'FromHeader', File: 'FromFile', Files: 'FromFile', CsvFile: 'FromCSV', JsonFile: 'FromJSONFile', Form: 'FromForm',
  FormField: 'FromFormField', Ip: 'IpRouteArgs', RequestId: 'RequestIdRouteArgs', UserAgent: 'UserAgentRouteArgs', Referer: 'RefererRouteArgs',
  RawBody: 'RawBodyRouteArgs', FromXml: 'FromXml', PKey: 'FromParams', Uuid: 'FromParams', Req: 'Req', Res: 'Res', Model: 'FromModel',
  FromModel: 'FromDbModel', AsModel: 'FromDbModel', Cookie: 'FromCookie',
};
export const ROUTE_METHODS: Record<string, RouteEntry['method']> = { Get: 'get', Post: 'post', Put: 'put', Patch: 'patch', Del: 'delete', Head: 'head' };
const SCHEMA_ARG_INDEX: Record<string, number> = { Query: 0, Param: 0, Header: 1, FormField: 0 };
const BUILTIN_SCHEMAS: Record<string, unknown> = {
  PKey: { type: 'number', minimum: 0 },
  Uuid: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$' },
};
const OPTIONS_ARG_INDEX: Record<string, number> = { Query: 1, Param: 1, Header: 2, FormField: 1, Body: 0, File: 0, Files: 0, Form: 0, JsonFile: 0, CsvFile: 0, FromXml: 0, Model: 0, FromModel: 0, AsModel: 0 };

type NamedClass = ts.ClassDeclaration & { name: ts.Identifier };

function joinPath(base: string | null, path: string): string {
  const parts = [base ?? '', path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

function isRequired(p: ts.ParameterDeclaration, type: ts.Type): boolean {
  if (p.questionToken || p.initializer) return false;
  const members = type.isUnion() ? type.types : [type];
  return !members.some((t) => t.flags & ts.TypeFlags.Undefined);
}

function paramOf(p: ts.ParameterDeclaration, index: number, owner: string, ctx: ExtractorContext): ParamEntry | undefined {
  const dec = decoratorsOf(p).find((d) => PARAM_KINDS[d.name]);
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
  return {
    index, name, kind: PARAM_KINDS[dec.name], runtimeType: ctx.typeRef(ctx.checker.getNonNullableType(type), p),
    required: options?.required === true || isRequired(p, type),
    ...(options !== undefined ? { options } : {}), ...(schemaId ? { schema: schemaId } : {}),
  };
}

function routeOf(m: ts.MethodDeclaration, basePath: string | null, className: string, ctx: ExtractorContext): RouteEntry | undefined {
  const dec = decoratorsOf(m).find((d) => ROUTE_METHODS[d.name]);
  if (!dec || !ts.isIdentifier(m.name)) return undefined;
  const handler = m.name.text;
  const path = (literalValue(dec.args[0], ctx) as string | undefined) ?? '';
  const sig = ctx.checker.getSignatureFromDeclaration(m);
  const returnType = sig ? ctx.typeRef(ctx.checker.getReturnTypeOfSignature(sig), m) : { text: 'unknown' };
  const { access, allowAnonymous } = accessOf(m, ctx);
  const doc = routeDocOf(m, ctx);
  return {
    method: ROUTE_METHODS[dec.name], path, handler, fullPath: joinPath(basePath, path),
    params: m.parameters.map((p, i) => paramOf(p, i, `${className}.${handler}`, ctx)).filter((p): p is ParamEntry => !!p),
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
  const { access, allowAnonymous } = accessOf(node, ctx);
  const condition = conditionOf(node, ctx);
  return {
    id: `${ctx.packageName}:${node.name.text}`, className: node.name.text, basePath, ...(basePathConfig ? { basePathConfig } : {}),
    policies: policyGroupsOf(node, ctx, 'class'), middlewares: middlewaresOf(node, ctx),
    ...(access ? { access } : {}), ...(allowAnonymous ? { allowAnonymous } : {}),
    routes: node.members.filter(ts.isMethodDeclaration).map((m) => routeOf(m, basePath, node.name.text, ctx)).filter((r): r is RouteEntry => !!r),
    ...(condition ? { condition } : {}), source: ctx.sourceRef(node),
  };
}

export const extractControllers: Extractor<ControllerEntry> = (ctx, file) => {
  const out: ControllerEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const hasRoute = node.members.some((m) => ts.isMethodDeclaration(m) && decoratorsOf(m).some((d) => ROUTE_METHODS[d.name]));
      if (hasRoute || ctx.isSubclassOf(node, 'BaseController')) out.push(controllerOf(node as NamedClass, ctx));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
