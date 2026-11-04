import { mockIssue, type MockSchema } from '../mocks/index.js';
import type { ClientModel } from './model.js';
import type { RouteModel } from './routes.js';
import { literal, propertyKey, type TypeContext } from './ts-type.js';
import { compare, type GeneratorDiagnostic } from './zod/diagnostics.js';

export interface MocksEmitResult {
  contents: string;
  diagnostics: GeneratorDiagnostic[];
}

type Json = Record<string, unknown>;

// Keys of these hold schemas by name, so a property called `x-foo` or `$ref` is data, not a keyword.
const NAMED_SCHEMAS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
// The server drops only `x-*` inside these values, so a `title` key there is data.
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
const DROPPED = new Set(['title', 'description', '$comment', '$id']);
const REPLY_TYPES: Record<string, MockSchema> = { string: { type: 'string' }, number: { type: 'number' }, boolean: { type: 'boolean' } };
// A reply with no schema to sample: the sampler reports `not` as unsupported, so the fallback throws MockUnsupported.
const UNSAMPLED: MockSchema = { not: {} };
const PAGE_HELPERS = ['mockCursorPage', 'mockPage'];

// x-explicit stays in schemas: the server accepts anything for a partial schema, which changes how allOf treats it.
const dropped = (name: string, data: boolean): boolean => (name.startsWith('x-') && (data || name !== 'x-explicit')) || (!data && DROPPED.has(name));

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The schema table the runtime samples from: manifest `$ref`s become names, and relative ones `Name#/…`. */
class Embedder {
  public readonly table = new Map<string, MockSchema>();
  private readonly ids = new Map<string, string>();
  private readonly pending: string[] = [];

  constructor(private readonly ctx: TypeContext) {}

  public has(id: string): boolean {
    return this.ctx.schemaOf(id) !== undefined;
  }

  /** Embeds the schema and every schema it references; returns its name. */
  public add(id: string): string {
    const name = this.enqueue(id);
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      const owner = this.ctx.nameOf(next);
      this.table.set(owner, this.embed(this.ctx.manifest.schemas[next], owner, false) as MockSchema);
    }
    return name;
  }

  public idOf(name: string): string {
    return this.ids.get(name) ?? name;
  }

  private enqueue(id: string): string {
    const name = this.ctx.nameOf(id);
    if (!this.ids.has(name)) {
      this.ids.set(name, id);
      this.pending.push(id);
    }
    return name;
  }

  private embed(value: unknown, owner: string, named: boolean, data = false): unknown {
    if (Array.isArray(value)) return value.map((item) => this.embed(item, owner, false, data));
    if (!isObject(value)) return value;
    const entries: [string, unknown][] = [];
    for (const [name, child] of Object.entries(value)) {
      if (!named && dropped(name, data)) continue;
      entries.push([
        name,
        !named && name === '$ref' && typeof child === 'string' ? this.ref(child, owner) : this.embed(child, owner, !named && NAMED_SCHEMAS.has(name), data || (!named && DATA_KEYWORDS.has(name))),
      ]);
    }
    // fromEntries defines an own `__proto__` key, where assignment would set the prototype.
    return Object.fromEntries(entries);
  }

  private ref(ref: string, owner: string): string {
    if (ref.startsWith('#')) return `${owner}${ref}`;
    const hash = ref.indexOf('#');
    const id = hash < 0 ? ref : ref.slice(0, hash);
    return this.has(id) ? `${this.enqueue(id)}${hash < 0 ? '' : ref.slice(hash)}` : ref;
  }
}

const key = (name: string): string => (name === '__proto__' ? `['__proto__']` : propertyKey(name));

function fits(text: string, indent: string): boolean {
  return indent.length + text.length <= 110 && !text.includes('\n');
}

/** A JSON value as a TypeScript literal, inline when short. */
function print(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => print(item, `${indent}  `));
    const inline = `[${items.join(', ')}]`;
    return fits(inline, indent) ? inline : `[\n${items.map((i) => `${indent}  ${i},`).join('\n')}\n${indent}]`;
  }
  if (!isObject(value)) return literal(value);
  const entries = Object.entries(value).map(([name, child]) => `${key(name)}: ${print(child, `${indent}  `)}`);
  if (entries.length === 0) return '{}';
  const inline = `{ ${entries.join(', ')} }`;
  return fits(inline, indent) ? inline : `{\n${entries.map((e) => `${indent}  ${e},`).join('\n')}\n${indent}}`;
}

function replySchema(route: RouteModel, embedder: Embedder, replies: Set<string>, unsampled: GeneratorDiagnostic[]): MockSchema | null {
  if (route.returns === 'void') return null;
  if (route.returnSchema !== undefined && embedder.has(route.returnSchema)) {
    const name = embedder.add(route.returnSchema);
    replies.add(name);
    return { $ref: name };
  }
  if (Object.hasOwn(REPLY_TYPES, route.returns)) return REPLY_TYPES[route.returns];
  const label = `${route.controllerKey}.${route.name}`;
  unsampled.push({ code: 'MOCK001', severity: 'warning', schema: label, pointer: '', message: `the createMockAppClient fallback for ${label} throws MockUnsupported: its reply type ${route.returns} has no schema to sample` });
  return UNSAMPLED;
}

function diagnosticsOf(embedder: Embedder, dtos: string[], replies: Set<string>): GeneratorDiagnostic[] {
  const table = Object.fromEntries(embedder.table);
  const out: GeneratorDiagnostic[] = [];
  for (const name of [...new Set([...dtos, ...replies])]) {
    const issue = mockIssue(table, name);
    const what = dtos.includes(name) ? `mock${name}()` : `the createMockAppClient fallback for ${name} replies`;
    if (issue) out.push({ code: 'MOCK001', severity: 'warning', schema: embedder.idOf(name), pointer: issue.pointer, message: `${what} throws MockUnsupported: ${issue.message}` });
  }
  return out.sort((a, b) => compare(a.schema, b.schema) || compare(a.pointer, b.pointer));
}

/**
 * Prints `client.mocks.ts`: `mock<Dto>()` per schema `client.ts` declares, the page helpers and `createMockAppClient`.
 * No other generated file imports it. A schema the sampler cannot honour gets diagnostic `MOCK001`, and its mock throws.
 */
export function emitMocks(model: ClientModel, clientModule = './client.js'): MocksEmitResult {
  const { ctx } = model;
  const embedder = new Embedder(ctx);
  const dtos = [...ctx.used].map((id) => embedder.add(id)).sort(compare);
  const replies = new Set<string>();
  const unsampled: GeneratorDiagnostic[] = [];
  const routes = model.controllers.map((c) => `  ${key(c.key)}: {\n${c.routes.map((r) => `    ${key(r.name)}: ${print(replySchema(r, embedder, replies, unsampled), '    ')},`).join('\n')}\n  },`);
  const schemas = [...embedder.table.keys()].sort(compare).map((name) => `  ${key(name)}: ${print(embedder.table.get(name), '  ')},`);
  const functions = dtos.map((name) =>
    [
      `export function mock${name}(overrides?: Partial<${name}>, options?: MockOptions): ${name} {`,
      `  return mockFrom<${name}>(schemas, ${literal(name)}, overrides, options);`,
      '}',
      '',
    ].join('\n'),
  );
  // A DTO named Page or CursorPage takes the name; its page helper stays importable from @spinajs/client/mocks.
  const helpers = PAGE_HELPERS.filter((helper) => !dtos.some((name) => `mock${name}` === helper));
  const lines = [
    `/* Generated by @spinajs/client (mocks) from app.manifest.json (hash ${model.manifestHash}). Do not edit. */`,
    `import { createMockClient, mockFrom, type MockOptions, type MockRouteTable, type MockSchema } from '@spinajs/client/mocks';`,
    `import type { ${['AppClient', ...dtos].sort(compare).join(', ')}, manifestHash } from '${clientModule}';`,
    '',
    `const _hash: typeof manifestHash = ${literal(model.manifestHash)};`,
    'void _hash;',
    '',
    schemas.length > 0 ? `const schemas: Record<string, MockSchema> = {\n${schemas.join('\n')}\n};` : 'const schemas: Record<string, MockSchema> = {};',
    '',
    routes.length > 0 ? `const routeTable: MockRouteTable = {\n${routes.join('\n')}\n};` : 'const routeTable: MockRouteTable = {};',
    '',
    ...functions,
    ...(helpers.length > 0 ? [`export { ${helpers.join(', ')} } from '@spinajs/client/mocks';`, ''] : []),
    'type PartialClient = { [C in keyof AppClient]?: Partial<AppClient[C]> };',
    '',
    `export function createMockAppClient(impl: PartialClient = {}, options?: { fallback?: 'throw' | 'mock'; seed?: number }): AppClient {`,
    '  return createMockClient<AppClient>(routeTable, schemas, impl, options);',
    '}',
  ];
  return { contents: `${lines.join('\n')}\n`, diagnostics: [...diagnosticsOf(embedder, dtos, replies), ...unsampled].sort((a, b) => compare(a.schema, b.schema) || compare(a.pointer, b.pointer)) };
}
