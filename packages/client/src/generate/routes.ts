import type { ControllerEntry, ParamEntry, ParamWire, RouteEntry } from '@spinajs/manifest';
import { clientPath, UnsupportedPathError, type ClientPath, type Placeholder } from './path.js';
import { literal, type TypeContext } from './ts-type.js';

const FILE_KINDS = new Set(['FromFile', 'FromCSV', 'FromJSONFile']);
const FILE_TYPE = 'Blob | File';
const SEGMENTS_TYPE = 'string[]';

export interface RouteSignature {
  name: string;
  args: string[];
  returns: string;
  definition: string;
}

interface Argument {
  name: string;
  type: string;
  required: boolean;
  wire: ParamWire;
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
function placeholderArguments(path: ClientPath, args: Argument[]): Argument[] {
  if (args.some((a) => a.wire.in === 'path' && a.wire.shape === 'whole')) return [];
  const bound = new Set(args.filter((a) => a.wire.in === 'path').map((a) => a.wire.name));
  const taken = new Set(args.map((a) => a.name));
  return path.placeholders
    .filter((p) => !bound.has(p.name))
    .map((p) => ({ name: taken.has(p.name) ? `${p.name}Path` : p.name, type: p.splat ? SEGMENTS_TYPE : 'string | number', required: !p.optional, wire: { in: 'path', name: p.name, shape: 'value' } }));
}

function sentArgument(param: ParamEntry, wire: ParamWire, placeholders: Map<string, Placeholder>, ctx: TypeContext): Argument {
  if (wire.in !== 'path') return { name: param.name, type: argumentType(param, wire, ctx), required: param.required, wire };
  // The runtime cannot build the URL without a path value, whatever the controller parameter says.
  const placeholder = wire.name !== undefined ? placeholders.get(wire.name) : undefined;
  return { name: param.name, type: placeholder?.splat ? SEGMENTS_TYPE : argumentType(param, wire, ctx), required: !placeholder?.optional, wire };
}

// FromBody reads req.body, which no parser fills for a multipart request: the handler would get null.
function refuseBodyWithMultipart(label: string, args: Argument[]): void {
  const names = (location: string) => args.filter((a) => a.wire.in === location).map((a) => `'${a.name}'`);
  const [body, multipart] = [names('body'), names('multipart')];
  if (body.length > 0 && multipart.length > 0) {
    throw new Error(`${label} sends body argument(s) ${body.join(', ')} next to multipart argument(s) ${multipart.join(', ')}; the server reads no body from a multipart request, so send those values with @FormField()`);
  }
}

function routeArguments(label: string, route: RouteEntry, path: ClientPath, ctx: TypeContext): Argument[] {
  const placeholders = new Map(path.placeholders.map((p) => [p.name, p]));
  const args: Argument[] = [];
  for (const param of [...route.params].sort((a, b) => a.index - b.index)) {
    const wire = sentWire(label, param);
    if (wire) args.push(sentArgument(param, wire, placeholders, ctx));
  }
  refuseBodyWithMultipart(label, args);
  return [...args, ...placeholderArguments(path, args)];
}

function parameterList(args: Argument[]): string[] {
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

export function routeSignature(controller: ControllerEntry, route: RouteEntry, ctx: TypeContext): RouteSignature {
  const label = routeLabel(controller, route);
  const path = pathOf(label, route);
  const args = routeArguments(label, route, path, ctx);
  const returns = ctx.typeOf(route.returnType);
  const parts = [
    `method: ${literal(route.method === 'file' ? 'get' : route.method)}`,
    `path: ${literal(path.template)}`,
    `args: [${args.map((a) => wireLiteral(a.wire)).join(', ')}]`,
    ...(returns === 'void' ? ['void: true'] : []),
  ];
  return { name: route.handler, args: parameterList(args), returns, definition: `{ ${parts.join(', ')} }` };
}

export function controllerKey(controller: ControllerEntry): string {
  const base = controllerBase(controller);
  return base.charAt(0).toLowerCase() + base.slice(1);
}

export function controllerBase(controller: ControllerEntry): string {
  return controller.className.replace(/Controller$/, '');
}
