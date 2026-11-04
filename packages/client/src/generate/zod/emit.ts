import type { ParamEntry } from '@spinajs/manifest';
import type { ZodOptions } from '../files.js';
import type { ClientModel } from '../model.js';
import { literal, propertyKey } from '../ts-type.js';
import { compare, Diagnostics, type GeneratorDiagnostic } from './diagnostics.js';
import { isPlainObject, nodesIn, Printer, reopen, UNKNOWN, type ZodNode } from './print.js';
import { isPartial, refsIn, SchemaGraph, type NamedSchema } from './refs.js';
import { REPLY_RUNTIME, replyClosure, replyName } from './replies.js';
import { ZodBuilder, type Variant } from './schema.js';

export type { ZodOptions } from '../files.js';
export type { GeneratorDiagnostic, GeneratorDiagnosticCode } from './diagnostics.js';

export interface ZodEmitResult {
  contents: string;
  diagnostics: GeneratorDiagnostic[];
}

/** How the server checks an argument, by its `ParameterType` (`http/src/route-args/manifest-schema.ts`, `DERIVED_KINDS`). */
type RootMode = 'closed' | 'strip' | 'loose';

const ROOT_MODES: Partial<Record<string, RootMode>> = {
  FromBody: 'strip',
  BodyFieldRouteArgs: 'strip',
  FromQuery: 'closed',
  FromParams: 'closed',
  FromHeader: 'closed',
  FromCookie: 'closed',
  QueryFieldRouteArgs: 'loose',
  ParamFieldRouteArgs: 'loose',
  HeadersFieldRouteArgs: 'loose',
};

interface Declared {
  name: string;
  node: ZodNode;
}

interface RouteArgument {
  param: ParamEntry;
  id: string;
  mode: RootMode;
}

const PURE = '/*#__PURE__*/ ';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ROUTE_INDENT = '      ';

function rootMode(param: ParamEntry): RootMode | undefined {
  const mode = ROOT_MODES[param.kind];
  if (!mode || !param.wire || param.wire.in === 'none' || param.runtimeType.schema === undefined) return undefined;
  return param.wire.shape === 'field' ? 'closed' : mode;
}

/** The arguments the server validates against their manifest schema, per controller key and handler. */
function routeArguments(model: ClientModel): Map<string, Map<string, RouteArgument[]>> {
  const out = new Map<string, Map<string, RouteArgument[]>>();
  for (const controller of model.controllers) {
    const routes = new Map<string, RouteArgument[]>();
    controller.routes.forEach((route, i) => {
      const params = [...controller.entry.routes[i].params].sort((a, b) => a.index - b.index);
      const args = params.flatMap((param): RouteArgument[] => {
        const mode = rootMode(param);
        const id = param.runtimeType.schema!;
        return mode ? [{ param, id, mode }] : [];
      });
      if (args.length > 0) routes.set(route.name, args);
    });
    if (routes.size > 0) out.set(controller.key, routes);
  }
  return out;
}

interface ReplyRoute {
  controller: string;
  name: string;
  id: string;
}

/** The routes whose reply has a schema: not `void`, and not a scalar the manifest has no schema for. */
function replyRoutes(model: ClientModel): ReplyRoute[] {
  return model.controllers.flatMap((c) => c.routes.flatMap((r) => (r.returnSchema !== undefined && r.returns !== 'void' && model.ctx.schemaOf(r.returnSchema) ? [{ controller: c.key, name: r.name, id: r.returnSchema }] : [])));
}

const containsLocalRef = (schema: unknown): boolean => refsIn(schema).some((ref) => ref.startsWith('#'));

class ZodFile {
  private readonly diagnostics: Diagnostics;
  private readonly printer: Printer;
  private readonly graph: SchemaGraph;
  private readonly builder: ZodBuilder;
  private readonly args: Map<string, Map<string, RouteArgument[]>>;
  private readonly declared = new Map<string, Declared>();
  private readonly replyNames = new Map<string, string>();
  private readonly replyRoutes: ReplyRoute[] = [];
  private readonly types = new Set<string>(['manifestHash']);
  private usesZod = false;

  constructor(
    private readonly model: ClientModel,
    options: ZodOptions,
  ) {
    const { ctx } = model;
    this.diagnostics = new Diagnostics(options.unsupported === 'error' ? 'error' : 'warning');
    this.printer = new Printer(options.mini === true);
    this.args = routeArguments(model);
    // An argument schema `client.ts` inlines is printed inline too, unless a local `$ref` needs it declared.
    if (options.replies) this.replyRoutes = replyRoutes(model);
    const inlineIds = [...this.allArgs().map((a) => a.id), ...this.replyRoutes.map((r) => r.id)];
    const inlineNamed = inlineIds.filter((id) => !ctx.used.has(id) && containsLocalRef(ctx.schemaOf(id)));
    this.graph = new SchemaGraph(ctx, [...ctx.used, ...inlineNamed, ...this.inlineRefs()]);
    this.builder = new ZodBuilder(this.graph, ctx, this.diagnostics, (entry, variant) => (variant === 'reply' ? this.replyNameOf(entry) : entry.name));
  }

  public emit(clientModule: string): ZodEmitResult {
    const declarations = this.graph.declarations.map((entry) => this.declaration(entry));
    const routes = this.routeSchemas();
    const replies = this.replies();
    const body = [...this.helpers(), ...declarations, routes, ...replies].join('\n\n');
    const formats = [...this.builder.formats].sort(compare);
    const lines = [
      `/* Generated by @spinajs/client (zod) from app.manifest.json (hash ${this.model.manifestHash}). Do not edit. */`,
      ...(this.usesZod ? [`import { z } from '${this.printer.mini ? 'zod/mini' : 'zod'}';`] : []),
      ...(formats.length ? [`import { ${formats.join(', ')} } from '@spinajs/client/formats';`] : []),
      `import type { ${[...this.types].sort(compare).join(', ')} } from '${clientModule}';`,
      '',
      `const _hash: typeof manifestHash = ${literal(this.model.manifestHash)};`,
      // Read once, so an app compiled with noUnusedLocals accepts the check.
      'void _hash;',
      '',
      body,
    ];
    return { contents: `${lines.join('\n')}\n`, diagnostics: this.diagnostics.list() };
  }

  private allArgs(): RouteArgument[] {
    return [...this.args.values()].flatMap((r) => [...r.values()].flat());
  }

  // Schemas an inlined argument schema references must be declared, even when `client.ts` has no interface for them.
  private inlineRefs(): string[] {
    const { ctx } = this.model;
    return this.allArgs()
      .map((a) => a.id)
      .filter((id) => !ctx.used.has(id))
      .flatMap((id) => refsIn(ctx.schemaOf(id)).filter((ref) => !ref.startsWith('#')));
  }

  // A name no declaration takes: declarations end in `Schema`, which a reply name never does, but a numbered one could meet it.
  private replyNameOf(entry: NamedSchema): string {
    let name = this.replyNames.get(entry.key);
    if (name === undefined) {
      const taken = new Set([...this.graph.declarations.map((d) => d.name), ...this.replyNames.values()]);
      const base = replyName(entry.name);
      name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
      this.replyNames.set(entry.key, name);
    }
    return name;
  }

  private declaration(entry: NamedSchema, variant: Variant = 'request'): string {
    const state = { annotated: false };
    const node = this.root(entry, state, variant);
    const name = variant === 'reply' ? this.replyNameOf(entry) : entry.name;
    if (variant === 'request') {
      this.declared.set(entry.key, { name, node });
      if (isPlainObject(node) && !state.annotated) this.builder.plainObjects.add(name);
    }
    const code = this.pure(this.printer.print(node));
    if (entry.typeName) this.types.add(entry.typeName);
    this.usesZod ||= state.annotated || entry.typeName !== undefined || !IDENTIFIER.test(code);
    const type = `${this.printer.typeName}<${entry.typeName ?? 'unknown'}>`;
    const hoisted = this.hoisted();
    if (state.annotated) return `${hoisted}export const ${name}: ${type} = ${code};`;
    return `${hoisted}export const ${name} = ${code}${entry.typeName ? ` satisfies ${type}` : ''};`;
  }

  // client.ts declares an interface for every named root, also for one that accepts anything.
  private root(entry: NamedSchema, state: { annotated: boolean }, variant: Variant): ZodNode {
    const custom: ZodNode = { kind: 'call', fn: entry.typeName ? 'custom' : 'unknown', ...(entry.typeName ? { typeArg: entry.typeName } : {}), acceptsUndefined: true };
    if (isPartial(entry.schema)) return custom;
    const refused = this.graph.refused(entry.key);
    if (refused !== undefined) {
      this.diagnostics.report('ZOD001', { schema: entry.owner, pointer: entry.pointer }, `the server does not validate this schema: ${refused}; it accepts any value`);
      return custom;
    }
    const node = this.builder.root(entry.schema, { at: { schema: entry.owner, pointer: entry.pointer }, current: entry.key, state, typePath: entry.typeName, variant });
    this.collectTypes(node);
    if (node.kind === 'call' && node.fn === 'unknown' && !node.checks?.length && !node.inputChecks?.length && !node.before?.length) {
      return { ...custom, ...(node.description !== undefined ? { description: node.description } : {}) };
    }
    return node;
  }

  private hoisted(): string {
    return this.builder
      .takeHoisted()
      .map(({ name, node }) => {
        this.collectTypes(node);
        return `const ${name} = ${this.pure(this.printer.print(node))};\n`;
      })
      .join('');
  }

  private pure(code: string): string {
    if (IDENTIFIER.test(code)) return code;
    this.usesZod = true;
    return PURE + code;
  }

  // Getter annotations and `z.custom<T>` name interfaces of `client.ts`.
  private collectTypes(node: ZodNode): void {
    const texts = nodesIn(node).flatMap((n) => {
      if (n.kind === 'call') return n.typeArg ? [n.typeArg] : [];
      return n.kind === 'object' ? n.properties.flatMap((p) => p.getter ?? []) : [];
    });
    const names = new Set([...this.model.ctx.used].map((id) => this.model.ctx.nameOf(id)));
    for (const text of texts) {
      for (const word of text.replace(/'(?:[^'\\]|\\.)*'/g, '').match(/[A-Za-z_$][\w$]*/g) ?? []) if (names.has(word)) this.types.add(word);
    }
  }

  private routeSchemas(): string {
    const controllers = [...this.args].map(([key, routes]) => {
      const handlers = [...routes].map(([name, args]) => {
        const values = args.map((a) => `${ROUTE_INDENT}${propertyKey(a.param.name)}: ${this.argument(a)},`);
        return `    ${propertyKey(name)}: {\n${values.join('\n')}\n    },`;
      });
      return `  ${propertyKey(key)}: {\n${handlers.join('\n')}\n  },`;
    });
    const literalBody = controllers.length ? `{\n${controllers.join('\n')}\n}` : '{}';
    const comment = '// Per-route argument schemas: a whole body root accepts and drops undeclared keys, as the server does.';
    return `${this.hoisted()}${comment}\nexport const routeSchemas = ${literalBody} as const;`;
  }

  private argument(arg: RouteArgument): string {
    return this.pure(this.printer.print(this.argumentRoot(arg), ROUTE_INDENT));
  }

  private argumentRoot(arg: RouteArgument): ZodNode {
    const declared = this.declared.get(arg.id);
    if (!declared) return this.inlineArgument(arg, 'request');
    const { name, node } = declared;
    if (arg.mode === 'closed') return { kind: 'ref', name };
    if (this.builder.plainObjects.has(name)) return { kind: 'shape', mode: arg.mode, of: name };
    const opened = reopen(node, arg.mode);
    return opened === node ? { kind: 'ref', name } : { ...opened, description: undefined };
  }

  private inlineArgument(arg: RouteArgument, variant: Variant): ZodNode {
    const schema = this.model.ctx.schemaOf(arg.id);
    const refused = this.graph.refusalOfSchema(schema, arg.id);
    if (refused !== undefined) {
      this.diagnostics.report('ZOD001', { schema: arg.id, pointer: '' }, `the server does not validate this argument: ${refused}; it accepts any value`);
      return UNKNOWN;
    }
    const node = this.builder.root(schema, { at: { schema: arg.id, pointer: '' }, variant });
    this.collectTypes(node);
    return arg.mode === 'closed' ? node : reopen(node, arg.mode);
  }

  /** Lenient variants of the schemas the replies reach, `replySchemas` keyed like `routeSchemas`, and `zodReplies`. */
  private replies(): string[] {
    if (this.replyRoutes.length === 0) return [];
    const usable = this.replyRoutes.filter((r) => this.replyUsable(r));
    const roots = usable.flatMap((r) => (this.graph.get(r.id) ? [r.id] : refsIn(this.model.ctx.schemaOf(r.id)).flatMap((ref) => this.graph.resolve(ref, r.id) ?? [])));
    const variants = replyClosure(this.graph, roots).map((entry) => this.declaration(entry, 'reply'));
    const byController = new Map<string, string[]>();
    for (const r of usable) byController.set(r.controller, [...(byController.get(r.controller) ?? []), `    ${propertyKey(r.name)}: ${this.reply(r)},`]);
    const controllers = [...byController].map(([key, lines]) => `  ${propertyKey(key)}: {\n${lines.join('\n')}\n  },`);
    const table = controllers.length ? `{\n${controllers.join('\n')}\n}` : '{}';
    return [
      ...variants,
      `${this.hoisted()}// Lenient reply schemas: a closed object strips the keys it does not declare, so a server deployed ahead of the app may add fields.\nexport const replySchemas = ${table} as const;`,
      REPLY_RUNTIME,
    ];
  }

  // A reply the server cannot be held to has no schema: Ajv refuses it, or the manifest could not read it.
  private replyUsable(route: ReplyRoute): boolean {
    const entry = this.graph.get(route.id);
    if (entry) return this.graph.refused(entry.key) === undefined && !isPartial(entry.schema);
    return this.graph.refusalOfSchema(this.model.ctx.schemaOf(route.id), route.id) === undefined;
  }

  private reply(route: ReplyRoute): string {
    const entry = this.graph.get(route.id);
    if (entry) return this.replyNameOf(entry);
    const node = this.builder.root(this.model.ctx.schemaOf(route.id), { at: { schema: route.id, pointer: '' }, variant: 'reply' });
    this.collectTypes(node);
    return this.pure(this.printer.print(node, '    '));
  }

  private helpers(): string[] {
    const used = this.builder.helpers;
    if (used.size === 0) return [];
    this.usesZod = true;
    const { mini, typeName: type } = this.printer;
    const tuple = `readonly [${type}, ${type}, ...${type}[]]`;
    const union = mini ? 'z.ZodMiniUnion' : 'z.ZodUnion';
    const pipe = (input: string, target: string): string => (mini ? `z.pipe(${input}, ${target})` : `${input}.pipe(${target})`);
    const helpers: string[] = [];
    if (used.has('oneOf')) {
      const check = "(value) => options.filter((option) => option.safeParse(value).success).length === 1, 'must match exactly one schema in oneOf'";
      helpers.push(`// Ajv's oneOf: exactly one member matches the value as sent (a member's output may have dropped keys).
function oneOf<const T extends ${tuple}>(options: T) {
  return ${pipe(`z.custom<z.input<${union}<T>>>(${check})`, 'z.union(options)')};
}`);
    }
    if (used.has('oneOfReply')) {
      const check = "(value) => {\n    const fits = exact.filter((option) => option.safeParse(value).success).length;\n    return fits === 1 || (fits === 0 && lenient.some((option) => option.safeParse(value).success));\n  }, 'must match exactly one schema in oneOf'";
      helpers.push(`// Ajv's oneOf for a reply: exactly one member fits the value as the server sends it; a value a newer server extended fits none exactly, and the first lenient member that takes it parses it.
function oneOfReply<const A extends ${tuple}, const B extends ${tuple}>(exact: A, lenient: B) {
  return ${pipe(`z.custom<z.input<${union}<A>>>(${check})`, 'z.union([...exact, ...lenient] as unknown as A)')};
}`);
    }
    return helpers;
  }
}

/** Prints `client.zod.ts`: one zod schema per schema `client.ts` declares, and `routeSchemas` for the validated arguments. */
export function emitZod(model: ClientModel, options: ZodOptions, clientModule = './client.js'): ZodEmitResult {
  return new ZodFile(model, options).emit(clientModule);
}
