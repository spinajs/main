import type { ControllerEntry, ParamEntry, RouteEntry } from '@spinajs/manifest';
import { literal, propertyKey, type TypeContext } from './ts-type.js';

// The *Field kinds inject the whole req.query / req.body / req.params object, typed by the parameter.
const QUERY_KINDS = new Set(['FromQuery', 'QueryFieldRouteArgs']);
const BODY_KINDS = new Set(['FromBody', 'BodyFieldRouteArgs', 'FromModel', 'FromDbModel', 'FromXml']);
const FILE_KINDS = new Set(['FromFile', 'FromCSV', 'FromJSONFile']);
const FORM_KINDS = new Set(['FromForm', 'FromFormField']);
const FILE_TYPE = 'Blob | File';

export interface RouteSignature {
  name: string;
  args: string[];
  returns: string;
  definition: string;
}

interface Classified {
  path: ParamEntry[];
  paramsObject?: ParamEntry;
  query?: ParamEntry;
  body?: ParamEntry;
  files: ParamEntry[];
  form: ParamEntry[];
}

function classify(route: RouteEntry): Classified {
  const out: Classified = { path: [], files: [], form: [] };
  for (const param of [...route.params].sort((a, b) => a.index - b.index)) {
    if (param.kind === 'FromParams') out.path.push(param);
    else if (param.kind === 'ParamFieldRouteArgs') out.paramsObject = param;
    else if (QUERY_KINDS.has(param.kind)) out.query = param;
    else if (BODY_KINDS.has(param.kind)) out.body = param;
    else if (FILE_KINDS.has(param.kind)) out.files.push(param);
    else if (FORM_KINDS.has(param.kind)) out.form.push(param);
  }
  return out;
}

function fieldsObject(fields: { name: string; type: string; required: boolean }[]): string {
  return `{ ${fields.map((f) => `${propertyKey(f.name)}${f.required ? '' : '?'}: ${f.type}`).join('; ')} }`;
}

function asField(param: ParamEntry, ctx: TypeContext, type?: string): { name: string; type: string; required: boolean } {
  return { name: param.name, type: type ?? ctx.typeOf(param.runtimeType), required: param.required };
}

function pathPlaceholders(fullPath: string): string[] {
  return [...fullPath.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

function pathArgument(route: RouteEntry, found: Classified, ctx: TypeContext): { names: string[]; arg?: string } {
  const names = pathPlaceholders(route.fullPath);
  if (names.length === 0) return { names };
  const fields = names.map((name) => {
    const param = found.path.find((p) => p.name === name);
    const type = param ? ctx.typeOf(param.runtimeType) : found.paramsObject && ctx.propertyType(found.paramsObject.runtimeType, name);
    return { name, type: type ?? 'string | number', required: true };
  });
  return { names, arg: `params: ${fieldsObject(fields)}` };
}

function queryArgument(found: Classified, ctx: TypeContext): { names: string[]; type?: string } {
  const names = found.query ? ctx.propertyNames(found.query.runtimeType) : [];
  // The runtime reserves the query slot only for a non-empty key list, so an unknown shape must not take an argument.
  return { names, ...(found.query && names.length > 0 ? { type: ctx.typeOf(found.query.runtimeType) } : {}) };
}

interface BodyArgument {
  kind: 'json' | 'multipart';
  type: string;
  required: boolean;
  files: string[];
}

function bodyArgument(found: Classified, ctx: TypeContext): BodyArgument | undefined {
  if (found.body) return { kind: 'json', type: ctx.typeOf(found.body.runtimeType), required: found.body.required, files: [] };
  if (found.files.length === 0 && found.form.length === 0) return undefined;
  const whole = found.form.filter((p) => p.kind === 'FromForm').map((p) => ctx.typeOf(p.runtimeType));
  const fields = [...found.form.filter((p) => p.kind === 'FromFormField').map((p) => asField(p, ctx)), ...found.files.map((p) => asField(p, ctx, FILE_TYPE))];
  const parts = [...(fields.length ? [fieldsObject(fields)] : []), ...whole];
  return { kind: 'multipart', type: parts.join(' & '), required: [...found.files, ...found.form].some((p) => p.required), files: found.files.map((p) => p.name) };
}

function list(values: string[]): string {
  return `[${values.map(literal).join(', ')}]`;
}

function returnType(route: RouteEntry, ctx: TypeContext): string {
  return ctx.typeOf(route.returnType);
}

export function routeSignature(route: RouteEntry, ctx: TypeContext): RouteSignature {
  const found = classify(route);
  const path = pathArgument(route, found, ctx);
  const query = queryArgument(found, ctx);
  const body = bodyArgument(found, ctx);

  const args: string[] = [];
  if (path.arg) args.push(path.arg);
  if (query.type) args.push(body ? `query: ${query.type} | undefined` : `query?: ${query.type}`);
  if (body) args.push(`body${body.required ? '' : '?'}: ${body.type}`);

  const returns = returnType(route, ctx);
  const parts = [
    `method: ${literal(route.method === 'file' ? 'get' : route.method)}`,
    `path: ${literal(route.fullPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?\??/g, '{$1}'))}`,
    `params: ${list(path.names)}`,
    ...(query.type ? [`query: ${list(query.names)}`] : []),
    ...(body ? [`body: ${literal(body.kind)}`] : []),
    ...(body && body.files.length > 0 ? [`files: ${list(body.files)}`] : []),
    ...(returns === 'void' ? ['void: true'] : []),
  ];
  return { name: route.handler, args, returns, definition: `{ ${parts.join(', ')} }` };
}

export function controllerKey(controller: ControllerEntry): string {
  const base = controllerBase(controller);
  return base.charAt(0).toLowerCase() + base.slice(1);
}

export function controllerBase(controller: ControllerEntry): string {
  return controller.className.replace(/Controller$/, '');
}
