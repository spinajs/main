import type { ControllerEntry, ParamEntry, ParamWire, RouteEntry } from '@spinajs/manifest';
import { literal, type TypeContext } from './ts-type.js';

const FILE_KINDS = new Set(['FromFile', 'FromCSV', 'FromJSONFile']);
const FILE_TYPE = 'Blob | File';
const PLACEHOLDER = /:([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?\??/g;

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

function sentWire(controller: ControllerEntry, route: RouteEntry, param: ParamEntry): ParamWire | undefined {
  if (!param.wire) {
    throw new Error(
      `generateClient: ${controller.className}.${route.handler} (${route.method.toUpperCase()} ${route.fullPath}) parameter '${param.name}' (${param.kind}) has no wire binding; rebuild the manifest with the current @spinajs/compiler`,
    );
  }
  return param.wire.in === 'none' ? undefined : param.wire;
}

function argumentType(param: ParamEntry, wire: ParamWire, ctx: TypeContext): string {
  if (wire.in === 'multipart' && FILE_KINDS.has(param.kind)) return wire.multiple ? `(${FILE_TYPE})[]` : FILE_TYPE;
  return ctx.typeOf(param.runtimeType);
}

// The server still needs a segment for a placeholder no argument reads, so the caller passes it.
function placeholderArguments(route: RouteEntry, args: Argument[]): Argument[] {
  if (args.some((a) => a.wire.in === 'path' && a.wire.shape === 'whole')) return [];
  const bound = new Set(args.filter((a) => a.wire.in === 'path').map((a) => a.wire.name));
  const taken = new Set(args.map((a) => a.name));
  return [...route.fullPath.matchAll(PLACEHOLDER)]
    .map((m) => m[1])
    .filter((name) => !bound.has(name))
    .map((name) => ({ name: taken.has(name) ? `${name}Path` : name, type: 'string | number', required: true, wire: { in: 'path', name, shape: 'value' } }));
}

function routeArguments(controller: ControllerEntry, route: RouteEntry, ctx: TypeContext): Argument[] {
  const args: Argument[] = [];
  for (const param of [...route.params].sort((a, b) => a.index - b.index)) {
    const wire = sentWire(controller, route, param);
    if (wire) args.push({ name: param.name, type: argumentType(param, wire, ctx), required: param.required, wire });
  }
  return [...args, ...placeholderArguments(route, args)];
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
  const args = routeArguments(controller, route, ctx);
  const returns = ctx.typeOf(route.returnType);
  const parts = [
    `method: ${literal(route.method === 'file' ? 'get' : route.method)}`,
    `path: ${literal(route.fullPath.replace(PLACEHOLDER, '{$1}'))}`,
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
