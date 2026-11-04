import { controllerKey, type ControllerEntry, type ParamEntry, type ParamWire, type RouteEntry } from '@spinajs/manifest';
import type { RouteDefinition } from '../runtime/http.js';
import { clientPath, UnsupportedPathError, type ClientPath, type Placeholder } from './path.js';
import { literal, type TypeContext } from './ts-type.js';

const FILE_KINDS = new Set(['FromFile', 'FromCSV', 'FromJSONFile']);
const FILE_TYPE = 'Blob | File';
const SEGMENTS_TYPE = 'string[]';

export interface ArgumentModel {
  name: string;
  type: string;
  required: boolean;
  wire: ParamWire;
  /** Manifest schema id of the parameter type, when the compiler recorded one. */
  schema?: string;
}

export type RouteKind = 'query' | 'mutation' | 'none';

export interface RouteModel {
  controllerKey: string;
  name: string;
  method: RouteDefinition['method'];
  kind: RouteKind;
  args: ArgumentModel[];
  /** TypeScript expression of the reply. */
  returns: string;
  returnSchema?: string;
  /** The route-table literal `client.ts` prints. */
  definition: string;
}

function routeLabel(controller: ControllerEntry, route: RouteEntry): string {
  return `generateClient: ${controller.className}.${route.handler} (${route.method.toUpperCase()} ${route.fullPath})`;
}

function sentWire(label: string, param: ParamEntry): ParamWire | undefined {
  if (!param.wire) throw new Error(`${label} parameter '${param.name}' (${param.kind}) has no wire binding; rebuild the manifest with the current @spinajs/compiler`);
  return param.wire.in === 'none' ? undefined : param.wire;
}

function pathOf(label: string, route: RouteEntry): ClientPath {
  try {
    return clientPath(route.fullPath);
  } catch (e) {
    if (e instanceof UnsupportedPathError) throw new Error(`${label} uses path syntax the client does not support: ${e.message}`, { cause: e });
    throw e;
  }
}

function argumentType(param: ParamEntry, wire: ParamWire, ctx: TypeContext): string {
  if (wire.in === 'multipart' && FILE_KINDS.has(param.kind)) return wire.multiple ? `(${FILE_TYPE})[]` : FILE_TYPE;
  return ctx.typeOf(param.runtimeType);
}

// The server still needs a segment for a placeholder no argument reads, so the caller passes it.
function placeholderArguments(path: ClientPath, args: ArgumentModel[]): ArgumentModel[] {
  if (args.some((a) => a.wire.in === 'path' && a.wire.shape === 'whole')) return [];
  const bound = new Set(args.filter((a) => a.wire.in === 'path').map((a) => a.wire.name));
  const taken = new Set(args.map((a) => a.name));
  return path.placeholders
    .filter((p) => !bound.has(p.name))
    .map((p) => ({ name: taken.has(p.name) ? `${p.name}Path` : p.name, type: p.splat ? SEGMENTS_TYPE : 'string | number', required: !p.optional, wire: { in: 'path', name: p.name, shape: 'value' } }));
}

function sentArgument(param: ParamEntry, wire: ParamWire, placeholders: Map<string, Placeholder>, ctx: TypeContext): ArgumentModel {
  const schema = param.runtimeType.schema !== undefined ? { schema: param.runtimeType.schema } : {};
  if (wire.in !== 'path') return { name: param.name, type: argumentType(param, wire, ctx), required: param.required, wire, ...schema };
  // The runtime cannot build the URL without a path value, whatever the controller parameter says.
  const placeholder = wire.name !== undefined ? placeholders.get(wire.name) : undefined;
  return { name: param.name, type: placeholder?.splat ? SEGMENTS_TYPE : argumentType(param, wire, ctx), required: !placeholder?.optional, wire, ...schema };
}

// FromBody reads req.body, which no parser fills for a multipart request: the handler would get null.
function refuseBodyWithMultipart(label: string, args: ArgumentModel[]): void {
  const names = (location: string) => args.filter((a) => a.wire.in === location).map((a) => `'${a.name}'`);
  const [body, multipart] = [names('body'), names('multipart')];
  if (body.length > 0 && multipart.length > 0) {
    throw new Error(`${label} sends body argument(s) ${body.join(', ')} next to multipart argument(s) ${multipart.join(', ')}; the server reads no body from a multipart request, so send those values with @FormField()`);
  }
}

function routeArguments(label: string, route: RouteEntry, path: ClientPath, ctx: TypeContext): ArgumentModel[] {
  const placeholders = new Map(path.placeholders.map((p) => [p.name, p]));
  const args: ArgumentModel[] = [];
  for (const param of [...route.params].sort((a, b) => a.index - b.index)) {
    const wire = sentWire(label, param);
    if (wire) args.push(sentArgument(param, wire, placeholders, ctx));
  }
  refuseBodyWithMultipart(label, args);
  return [...args, ...placeholderArguments(path, args)];
}

export function parameterList(args: ArgumentModel[]): string[] {
  const lastRequired = args.map((a) => a.required).lastIndexOf(true);
  return args.map((a, i) => {
    if (a.required) return `${a.name}: ${a.type}`;
    return i < lastRequired ? `${a.name}: ${a.type} | undefined` : `${a.name}?: ${a.type}`;
  });
}

function wireLiteral(wire: ParamWire): string {
  const parts = [`in: ${literal(wire.in)}`, ...(wire.name !== undefined ? [`name: ${literal(wire.name)}`] : []), `shape: ${literal(wire.shape)}`, ...(wire.multiple ? ['multiple: true'] : [])];
  return `{ ${parts.join(', ')} }`;
}

// A file route is a download link, not cached data, and a HEAD reply has no body to cache.
function routeKind(method: RouteEntry['method']): RouteKind {
  if (method === 'get') return 'query';
  return method === 'head' || method === 'file' ? 'none' : 'mutation';
}

export function routeModel(controller: ControllerEntry, route: RouteEntry, ctx: TypeContext): RouteModel {
  const label = routeLabel(controller, route);
  const path = pathOf(label, route);
  const args = routeArguments(label, route, path, ctx);
  const returns = ctx.typeOf(route.returnType);
  const method = route.method === 'file' ? 'get' : route.method;
  const parts = [`method: ${literal(method)}`, `path: ${literal(path.template)}`, `args: [${args.map((a) => wireLiteral(a.wire)).join(', ')}]`, ...(returns === 'void' ? ['void: true'] : [])];
  return {
    controllerKey: controllerKey(controller),
    name: route.handler,
    method,
    kind: routeKind(route.method),
    args,
    returns,
    ...(route.returnType.schema !== undefined ? { returnSchema: route.returnType.schema } : {}),
    definition: `{ ${parts.join(', ')} }`,
  };
}

export function controllerBase(controller: ControllerEntry): string {
  return controller.className.replace(/Controller$/, '');
}
