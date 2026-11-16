import * as formats from '../../formats/index.js';
import { literal, propertyKey, type TypeContext } from '../ts-type.js';
import { child, type Diagnostics, type Location } from './diagnostics.js';
import { dataChecks, DATA_KEYWORDS, isDataRef, locationKey } from './data-refs.js';
import { arrayChecks, inputChecks, rangeChecks, regexpCheck, transform, type KeywordHost } from './keywords.js';
import { resolveMergePatch } from './merge-patch.js';
import { call, nodesIn, reopen, UNKNOWN, use, valueCode, type Check, type Property, type ZodNode } from './print.js';
import { isJson, isPartial, refsIn, type Json, type NamedSchema, type SchemaGraph } from './refs.js';

/** Where the builder is: the node's location, the declaration it belongs to, and whether a getter already defers it. */
export interface Scope {
  at: Location;
  /** The key of the declaration being built; undefined for a schema printed inline. */
  current?: string;
  deferred?: boolean;
  /** Set when the declaration reads itself through `z.lazy`, which needs an explicit type. */
  state?: { annotated: boolean };
  /** The TypeScript type of the object being built, as `client.ts` declares it, for getter annotations. */
  typePath?: string;
  /** Which variant of the schemas is built; `request` when absent. */
  variant?: Variant;
}

/**
 * - `request`: `<Name>Schema`, as the server validates a JSON body.
 * - `reply`: a lenient reply variant (FG-7), whose checks read the request schemas.
 */
export type Variant = 'request' | 'reply';

// Each variant hoists its checks under its own prefix, so the variants of one schema can be told apart.
const HOIST_PREFIX: Record<Variant, string> = { request: '_check', reply: '_replyCheck' };

// Keywords the emitter cannot map: dropping one makes the schema looser than the server.
const UNMAPPED = new Set([
  'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems', '$async', 'formatMinimum', 'formatMaximum', 'formatExclusiveMinimum',
  'formatExclusiveMaximum', 'instanceof', 'select', 'selectCases', 'selectDefault', 'dynamicDefaults', 'typeof', 'allRequired', 'anyRequired', 'oneRequired',
  'patternRequired', 'prohibited', 'deepProperties', 'deepRequired',
]);

// The draft-07 keywords and annotations, Ajv's `nullable`, and the plugin keywords the emitter maps. Any other key is a
// keyword the server's Ajv does not know, such as one an app adds in `createAppAjv()`.
const KNOWN = new Set([
  '$id', '$schema', '$ref', '$comment', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated',
  'contentMediaType', 'contentEncoding', 'type', 'nullable', 'enum', 'const', 'format', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum',
  'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'items', 'additionalItems', 'maxItems', 'minItems', 'uniqueItems', 'contains', 'maxProperties',
  'minProperties', 'required', 'properties', 'patternProperties', 'additionalProperties', 'dependencies', 'propertyNames', 'if', 'then', 'else', 'allOf',
  'anyOf', 'oneOf', 'not', '$merge', '$patch', 'range', 'exclusiveRange', 'transform', 'regexp', 'uniqueItemProperties',
]);

// Merge patches resolving to further merge patches: past this depth the chain is cut with ZOD003.
const MAX_MERGE_DEPTH = 8;

const STRING_KEYWORDS = ['minLength', 'maxLength', 'pattern'];
const NUMBER_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const ARRAY_KEYWORDS = ['items', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems'];
const OBJECT_KEYWORDS = ['properties', 'required', 'additionalProperties'];
const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'] as const;
type JsonType = (typeof TYPES)[number];

const GUARDS: Record<JsonType, string> = {
  string: "typeof v === 'string'",
  number: "typeof v === 'number'",
  integer: "typeof v === 'number'",
  boolean: "typeof v === 'boolean'",
  null: 'v === null',
  array: 'Array.isArray(v)',
  object: "typeof v === 'object' && v !== null && !Array.isArray(v)",
};

// json-schema-to-typescript's default `maxItems`: the longest bounded array it still writes as a union of tuples.
const MAX_TUPLE_ITEMS = 20;
// Ajv accepts these strings without a check.
const UNCHECKED_FORMATS = new Set(['password', 'binary', 'float', 'double']);

const has = (schema: Json, keys: string[]): boolean => keys.some((k) => k in schema);

// A slot schema this small is printed in every tuple; anything else is declared once.
const isSimple = (schema: unknown): boolean => {
  if (schema === undefined || schema === true) return true;
  const scalar = (type: unknown): boolean => typeof type === 'string' && type !== 'object' && type !== 'array';
  return isJson(schema) && Object.keys(schema).every((k) => k === '$ref' || (k === 'type' && scalar(schema.type)));
};

/** The members of a type-less node's checks: the types its keywords apply to. */
function impliedTypes(schema: Json): JsonType[] {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  return TYPES.filter((t) => {
    if (t === 'string') return has(schema, STRING_KEYWORDS) || (format !== undefined && formats.formatPredicate(format) !== undefined);
    if (t === 'number') return has(schema, NUMBER_KEYWORDS) || (format !== undefined && formats.numberFormatPredicate(format) !== undefined);
    return (t === 'array' && has(schema, ARRAY_KEYWORDS)) || (t === 'object' && has(schema, OBJECT_KEYWORDS));
  });
}

/**
 * The lengths a bounded array allows, printed as json-schema-to-typescript types it (see `ZodBuilder.lengths`), and how
 * often each slot schema is printed: `uses[i]` for tuple position `i`, `restUses` for the rest.
 */
type ArrayShape = ({ kind: 'exact'; from: number; to: number } | { kind: 'array' } | { kind: 'open'; from: number; fixed: number }) & { uses: number[]; restUses: number };

function arrayShape(prefix: number, hasRest: boolean, min: number, max: number | undefined): ArrayShape {
  const count = (from: number, to: number, slot: number): number => Math.max(0, to - Math.max(from, slot + 1) + 1);
  const uses = (from: number, to: number, open: boolean): number[] => Array.from({ length: prefix }, (_, i) => count(from, to, i) + (open ? 1 : 0));
  if (!hasRest || (max !== undefined && max <= MAX_TUPLE_ITEMS)) {
    const to = hasRest ? (max ?? prefix) : Math.min(max ?? prefix, prefix);
    let restUses = 0;
    for (let length = min; length <= to; length++) restUses += Math.max(0, length - prefix);
    return { kind: 'exact', from: min, to, uses: uses(min, to, false), restUses };
  }
  if (prefix === 0 && min === 0) return { kind: 'array', uses: [], restUses: 1 };
  const fixed = Math.max(min, prefix);
  return { kind: 'open', from: min, fixed, uses: uses(min, prefix - 1, true), restUses: fixed - prefix + 1 };
}

const ownProperties = (schema: Json): Json => (isJson(schema.properties) ? schema.properties : {});

const requiredOf = (schema: Json): string[] => (Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);

const acceptsAnything = (schema: unknown): boolean =>
  schema === true || isPartial(schema) || (isJson(schema) && Object.keys(schema).every((k) => k.startsWith('$') || k.startsWith('x-') || k === 'description' || k === 'title'));

// The schema a `$merge` source names is registered under its own `$id`; the merged copy must not claim it again.
function withoutId(schema: unknown): unknown {
  if (!isJson(schema) || !('$id' in schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$id' && !key.startsWith('x-')));
}

function withoutKey(schema: Json, key: string): Json {
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key));
}

function formatExport(name: string): string {
  return `is${name.replace(/(^|-)([a-z0-9])/g, (_m, _dash, c: string) => c.toUpperCase())}`;
}

/** A TypeScript type expression of a JSON value: a `const` or `enum` member. */
function valueType(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(valueType).join(', ')}]`;
  if (isJson(value)) {
    const members = Object.entries(value).map(([k, v]) => `${propertyKey(k)}: ${valueType(v)}`);
    return members.length ? `{ ${members.join('; ')} }` : 'Record<string, never>';
  }
  return literal(value);
}

/** Turns manifest JSON Schema nodes into zod nodes, as `ManifestValidator`'s Ajv validates them. */
export class ZodBuilder {
  /** Names imported from `@spinajs/client/formats`. */
  public readonly formats = new Set<string>();
  public readonly helpers = new Set<'oneOf' | 'oneOfReply'>();
  /** Names of declarations that print as a plain strict object, so `z.looseObject(X.shape)` opens them. */
  public readonly plainObjects = new Set<string>();
  private readonly hoisted: { name: string; node: ZodNode }[] = [];
  private hoistedCount = 0;
  /** Locations of `$data` keywords a parent object checks; see `dataChecks`. */
  private readonly dataHandled = new Set<string>();
  private mergeDepth = 0;

  constructor(
    private readonly graph: SchemaGraph,
    private readonly ctx: TypeContext,
    private readonly diagnostics: Diagnostics,
    /** The const a reference reads in a variant: the referenced declaration's own variant, or its request schema. */
    private readonly variantName: (entry: NamedSchema, variant: Variant) => string = (entry) => entry.name,
  ) {}

  /** A whole manifest schema, or a local definition hoisted out of one; `SchemaGraph.refused` has turned away the ones Ajv refuses. */
  public root(schema: unknown, scope: Scope): ZodNode {
    return this.node(schema, scope);
  }

  public node(schema: unknown, scope: Scope): ZodNode {
    if (schema === true) return UNKNOWN;
    if (schema === false) return call('never');
    if (!isJson(schema)) {
      this.diagnostics.report('ZOD001', scope.at, 'not a JSON Schema; this node accepts any value');
      return UNKNOWN;
    }
    this.reportUnmapped(schema, scope);
    const node = this.conjunction(this.parts(schema, scope), scope);
    const input = inputChecks(schema, this.host(scope));
    const before = [transform(schema, this.host(scope))].filter((fn): fn is string => fn !== undefined);
    return {
      ...node,
      ...(input.length ? { inputChecks: [...(node.inputChecks ?? []), ...input] } : {}),
      ...(before.length ? { before: [...before, ...(node.before ?? [])] } : {}),
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    };
  }

  private host(scope: Scope): KeywordHost {
    return {
      at: scope.at,
      variant: scope.variant ?? 'request',
      format: (name) => this.format(name),
      subject: (schema, at) => this.subject(schema, { ...scope, at, typePath: undefined }),
      unmapped: (at, message) => this.diagnostics.report('ZOD003', at, message),
    };
  }

  /**
   * A schema a check reads: declared once before the declaration, or inline inside a getter, where a later one may be
   * read. A reply variant's `not` and `if` test what the server would accept, so they read the request schemas.
   */
  private subject(schema: unknown, scope: Scope): ZodNode {
    const inner: Scope = scope.variant === 'reply' ? { ...scope, variant: 'request' } : scope;
    return this.usable(this.node(schema, inner), inner);
  }

  private usable(node: ZodNode, scope: Scope): ZodNode {
    return node.kind === 'ref' || scope.deferred ? node : { kind: 'ref', name: this.hoist(node, scope) };
  }

  /**
   * The parts of one node, all of which must match. A closed object among them carries the others as checks: in a
   * `z.intersection`, zod 4.4 and later ignore a key one side rejects when the other side accepts it, and the server
   * keeps the object closed. Inside a getter the parts may read later declarations, so they cannot be hoisted.
   */
  private conjunction(parts: ZodNode[], scope: Scope): ZodNode {
    if (parts.length === 0) return UNKNOWN;
    const closed = parts.find((p) => p.kind === 'object' && p.mode === 'strict');
    if (parts.length > 1 && !closed && this.rewrites(parts)) return this.sequential(parts, scope);
    if (!closed || parts.length === 1 || scope.deferred) return parts.reduce((a, b) => call('intersection', { node: a }, { node: b }));
    const checks = parts
      .filter((p) => p !== closed)
      .map((p): Check => {
        const schema = p.kind === 'ref' ? p.name : this.hoist(p, scope);
        return { kind: 'refine', fn: `(v) => ${schema}.safeParse(v).success`, message: 'must match every schema of the node' };
      });
    return { ...closed, checks: [...(closed.checks ?? []), ...checks] };
  }

  // A part that rewrites the value (`transform`) and another that passes it through give outputs zod cannot merge.
  private rewrites(parts: ZodNode[]): boolean {
    return parts.some((p) => nodesIn(p).some((n) => n.before?.length));
  }

  /**
   * Parts that rewrite the value (coercion, `transform`) cannot be intersected: zod throws when the two outputs differ.
   * The object parts are joined with stripped outputs, which merge, and the others check the joined value, as Ajv's
   * later keywords see what the earlier ones coerced.
   */
  private sequential(parts: ZodNode[], scope: Scope): ZodNode {
    const isObject = (p: ZodNode): boolean => p.kind === 'object' || p.kind === 'shape';
    const loose = (p: ZodNode): boolean => isObject(p) && (p as { mode: string }).mode === 'loose' && !p.checks?.length && !p.inputChecks?.length;
    const strip = (p: ZodNode): ZodNode => (loose(p) ? ({ ...p, mode: 'strip' } as ZodNode) : p);
    const objects = parts.filter(isObject).map(strip);
    const base = objects.length ? objects.reduce((a, b) => call('intersection', { node: a }, { node: b })) : parts[0];
    const others = parts.filter((p) => !isObject(p) && p !== base);
    const checks = others.map((p): Check => {
      return { kind: 'refine', fn: `(v) => ${use(0)}.safeParse(v).success`, uses: [this.usable(p, scope)], message: 'must match every schema of the node' };
    });
    return checks.length ? { ...base, checks: [...(base.checks ?? []), ...checks] } : base;
  }

  /** The TypeScript type of `schema`'s values, as `client.ts` declares it; for a getter's annotation. */
  public typeOf(schema: unknown): string {
    const declared = refsIn(schema).every((ref) => ref.startsWith('#') || !this.ctx.schemaOf(ref) || this.ctx.used.has(ref));
    return declared ? this.ctx.expression(schema) : 'unknown';
  }

  // Ajv applies every keyword of a node: each group becomes one part, and the parts are intersected.
  private parts(schema: Json, scope: Scope): ZodNode[] {
    if ('const' in schema && !isDataRef(schema.const)) return [this.constant(schema.const)];
    const parts: ZodNode[] = [...this.mergePatch(schema, scope)];
    const nested: Scope = { ...scope, typePath: undefined };
    let objectDone = false;
    if (Array.isArray(schema.allOf)) {
      const merged = this.mergedAllOf(schema, scope);
      objectDone = merged !== undefined;
      parts.push(...(merged ? [merged] : schema.allOf.map((m, i) => this.allOfMember(m, i, nested))));
    }
    if (typeof schema.$ref === 'string') parts.push(this.ref(schema.$ref, nested));
    if (Array.isArray(schema.enum)) parts.push(this.enumeration(schema.enum));
    if (!objectDone && (!Array.isArray(schema.enum) || has(schema, [...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS, ...OBJECT_KEYWORDS, 'format']))) {
      const typed = this.typed(schema, scope);
      if (typed) parts.push(typed);
    }
    if (Array.isArray(schema.anyOf)) parts.push(this.anyOf(schema.anyOf, nested));
    if (Array.isArray(schema.oneOf)) parts.push(this.oneOf(schema, schema.oneOf, nested));
    return parts;
  }

  /**
   * An `allOf` member that is not merged: the server opens a closed one (`opened` in `ManifestSchemaPreparer.intersection`)
   * whatever the other members are. zod 4.1 to 4.3 would let a strict member reject the keys of the others.
   */
  private allOfMember(member: unknown, i: number, scope: Scope): ZodNode {
    const at = child(scope.at, 'allOf', i);
    const target = this.target(member, at, new Set());
    const closed = target && (this.closedShape(target.schema, target.at, target.seen, false) ?? this.closedObject(target.schema, target.at));
    if (!target || !closed) return this.node(member, { ...scope, at });
    const key = target.schema === member ? undefined : this.graph.resolve((member as Json).$ref as string, at.schema);
    const entry = key === undefined ? undefined : this.graph.get(key);
    const name = entry && this.nameOf(entry, scope);
    if (entry && name && this.plainObjects.has(name) && !this.graph.cyclic(scope.current, entry.key)) return { kind: 'shape', mode: 'loose', of: name };
    return reopen(this.node(target.schema, { ...scope, at: target.at }), 'loose');
  }

  private reportUnmapped(schema: Json, scope: Scope): void {
    for (const [key, value] of Object.entries(schema)) {
      if (UNMAPPED.has(key)) this.diagnostics.report('ZOD003', child(scope.at, key), `keyword '${key}' is not mapped and is dropped; the schema accepts more than the server`);
      else if (isDataRef(value) && (!DATA_KEYWORDS.includes(key) || !this.dataHandled.has(locationKey(child(scope.at, key))))) {
        this.diagnostics.report('ZOD003', child(scope.at, key), `$data in '${key}' is not mapped and is dropped; the schema accepts more than the server`);
      } else if (!KNOWN.has(key) && !key.startsWith('x-')) {
        this.diagnostics.report('ZOD003', child(scope.at, key), `keyword '${key}' is unknown to the server's default Ajv; one an app adds is not mapped and is dropped`);
      }
    }
  }

  /** `$merge` and `$patch`, resolved now, as a part next to the node's other keywords. */
  private mergePatch(schema: Json, scope: Scope): ZodNode[] {
    return (['$merge', '$patch'] as const).flatMap((keyword) => {
      if (!(keyword in schema)) return [];
      const at = child(scope.at, keyword);
      const target = (ref: string): unknown => this.graph.get(this.graph.resolve(ref, scope.at.schema) ?? '')?.schema;
      const resolved = this.mergeDepth < MAX_MERGE_DEPTH ? resolveMergePatch(keyword, schema[keyword], target) : { error: 'merge patches nest too deep' };
      if ('error' in resolved) {
        this.diagnostics.report('ZOD003', at, `${resolved.error}; it is dropped, and the schema accepts more than the server`);
        return [];
      }
      this.mergeDepth++;
      try {
        return [this.node(withoutId(resolved.schema), { ...scope, at, typePath: undefined })];
      } finally {
        this.mergeDepth--;
      }
    });
  }

  private nameOf(entry: NamedSchema, scope: Scope): string {
    return this.variantName(entry, scope.variant ?? 'request');
  }

  private ref(ref: string, scope: Scope): ZodNode {
    const key = this.graph.resolve(ref, scope.at.schema);
    const entry = key === undefined ? undefined : this.graph.get(key);
    if (!key || !entry) {
      this.diagnostics.report('ZOD001', child(scope.at, '$ref'), `$ref '${ref}' is not a schema of the manifest; this node accepts any value`);
      return UNKNOWN;
    }
    const acceptsUndefined = acceptsAnything(entry.schema);
    const name = this.nameOf(entry, scope);
    if (this.graph.cyclic(scope.current, key) && !scope.deferred) {
      if (scope.state) scope.state.annotated = true;
      return { ...call('lazy', { lazy: name }), acceptsUndefined };
    }
    return { kind: 'ref', name, acceptsUndefined };
  }

  private constant(value: unknown): ZodNode {
    if (value === null) return call('null');
    if (typeof value !== 'object') return call('literal', { code: literal(value) });
    const check = `(v) => ${this.format('ajvEqual')}(v, ${valueCode(value)})`;
    return { kind: 'call', fn: 'custom', typeArg: valueType(value), args: [{ code: check }, { code: literal('must be equal to constant') }] };
  }

  private enumeration(values: unknown[]): ZodNode {
    const unique = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];
    if (unique.length === 0) return call('never');
    if (unique.every((v) => typeof v === 'string')) return call('enum', { code: `[${unique.map(literal).join(', ')}]` });
    if (unique.every((v) => v === null || typeof v !== 'object')) {
      return unique.length === 1 ? this.constant(unique[0]) : call('literal', { code: `[${unique.map(literal).join(', ')}]` });
    }
    const members = unique.map(valueCode).join(', ');
    return {
      kind: 'call',
      fn: 'custom',
      typeArg: [...new Set(unique.map(valueType))].join(' | '),
      args: [{ code: `(v) => [${members}].some((e) => ${this.format('ajvEqual')}(v, e))` }, { code: literal('must be equal to one of the allowed values') }],
    };
  }

  private anyOf(members: unknown[], scope: Scope): ZodNode {
    const isNull = (m: unknown): boolean => isJson(m) && m.type === 'null' && Object.keys(m).length === 1;
    const nodes = members.map((m, i) => ({ m, node: () => this.node(m, { ...scope, at: child(scope.at, 'anyOf', i) }) }));
    const others = nodes.filter((n) => !isNull(n.m));
    if (others.length === 1 && others.length < nodes.length) return { ...others[0].node(), nullable: true };
    const lenient = nodes.map((n) => n.node());
    return this.union([...this.exact(members, 'anyOf', lenient, scope), ...lenient]);
  }

  /**
   * The members as the server checks them, for a reply: a value that fits one exactly must come out unchanged, where a
   * lenient member declared before it would strip the keys of the member it fits. Members that print the same are not repeated.
   */
  private exact(members: unknown[], keyword: 'anyOf' | 'oneOf', lenient: ZodNode[], scope: Scope): ZodNode[] {
    if (scope.variant !== 'reply') return [];
    const exact = members.map((m, i) => this.node(m, { ...scope, variant: 'request', at: child(scope.at, keyword, i) }));
    return exact.every((node, i) => JSON.stringify(node) === JSON.stringify(lenient[i])) ? [] : exact;
  }

  private union(nodes: ZodNode[]): ZodNode {
    if (nodes.length === 0) return call('never');
    return nodes.length === 1 ? nodes[0] : { ...call('union', { list: nodes }), acceptsUndefined: nodes.some((n) => n.acceptsUndefined) };
  }

  private oneOf(schema: Json, members: unknown[], scope: Scope): ZodNode {
    const nodes = members.map((m, i) => this.node(m, { ...scope, at: child(scope.at, 'oneOf', i) }));
    if (nodes.length <= 1) return nodes[0] ?? call('never');
    const discriminator = this.discriminator(schema, members, nodes, scope.at.schema);
    if (discriminator) return call('discriminatedUnion', { code: literal(discriminator) }, { list: nodes });
    const exact = this.exact(members, 'oneOf', nodes, scope);
    this.helpers.add(exact.length > 0 ? 'oneOfReply' : 'oneOf');
    if (exact.length > 0) return { kind: 'call', fn: 'oneOfReply', helper: true, args: [{ list: exact }, { list: nodes }] };
    return { kind: 'call', fn: 'oneOf', helper: true, args: [{ list: nodes }] };
  }

  // `x-discriminator` comes only with `$ref` members that each fix the property to a literal; a lazy member cannot be told apart.
  private discriminator(schema: Json, members: unknown[], nodes: ZodNode[], owner: string): string | undefined {
    const spec = schema['x-discriminator'];
    const property = isJson(spec) && typeof spec.propertyName === 'string' ? spec.propertyName : undefined;
    if (property === undefined || nodes.some((n) => n.kind !== 'ref')) return undefined;
    const tags: unknown[] = [];
    const objects = members.every((m) => {
      const target = isJson(m) && typeof m.$ref === 'string' ? this.graph.get(this.graph.resolve(m.$ref, owner) ?? '')?.schema : undefined;
      const tag = isJson(target) ? ownProperties(target)[property] : undefined;
      if (!isJson(target) || target.type !== 'object' || has(target, ['allOf', 'anyOf', 'oneOf', '$ref']) || !isJson(tag)) return false;
      if ('const' in tag) tags.push(tag.const);
      else if (Array.isArray(tag.enum)) tags.push(...(tag.enum as unknown[]));
      else return false;
      return true;
    });
    // zod refuses to build a discriminated union whose members share a tag value; the oneOf helper accepts it as Ajv does.
    const distinct = new Set(tags.map((t) => JSON.stringify(t))).size === tags.length;
    return objects && distinct ? property : undefined;
  }

  private typed(schema: Json, scope: Scope): ZodNode | undefined {
    const declared = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : undefined;
    if (declared === undefined) return this.untyped(schema, scope);
    const unknown = declared.find((t) => !(TYPES as readonly unknown[]).includes(t));
    if (unknown !== undefined) {
      this.diagnostics.report('ZOD001', child(scope.at, 'type'), `type '${String(unknown)}' is not a JSON Schema type; Ajv refuses the schema, and this node accepts any value`);
      return UNKNOWN;
    }
    const types = (declared as JsonType[]).filter((t, i, all) => all.indexOf(t) === i && !(t === 'integer' && all.includes('number')));
    if (schema.nullable === true && !types.includes('null')) types.push('null');
    const others = types.filter((t) => t !== 'null');
    const nullable = others.length < types.length;
    const objectPath = others.length === 1 && others[0] === 'object' ? scope.typePath : undefined;
    const objectScope: Scope = { ...scope, typePath: objectPath && nullable ? `NonNullable<${objectPath}>` : objectPath };
    if (others.length === 1 && nullable) return { ...this.branch(others[0], schema, objectScope), nullable: true };
    return this.union(types.map((t) => this.branch(t, schema, others.length === 1 ? objectScope : { ...scope, typePath: undefined })));
  }

  // Without `type`, a keyword checks only values of its own type, and every other value passes.
  private untyped(schema: Json, scope: Scope): ZodNode | undefined {
    const implied = impliedTypes(schema);
    this.unknownFormat(schema, scope);
    const combined = has(schema, ['$ref', 'allOf', 'anyOf', 'oneOf', 'enum', 'const']);
    const typedLikeClient = implied.length > 0 && implied.every((t) => t === 'object' || (t === 'array' && 'items' in schema));
    if (combined || typedLikeClient) return implied.length ? this.typelessChecks(schema, implied, { ...scope, typePath: undefined }) : undefined;
    if (!Object.keys(schema).some((k) => !k.startsWith('x-') && !['$id', '$schema', 'title'].includes(k))) return undefined;
    // client.ts types this node as json-schema-to-typescript does: by the type of its `default`, else as an open object.
    const type = ['string', 'number', 'boolean'].includes(typeof schema.default) ? typeof schema.default : '{ [k: string]: unknown }';
    if (implied.length === 0) return { kind: 'call', fn: 'custom', typeArg: type, acceptsUndefined: true };
    // Built outside any getter: the hoisted const is evaluated when the module loads.
    const checks = this.hoist(this.typelessChecks(schema, implied, { ...scope, deferred: false, typePath: undefined }), scope);
    return { kind: 'call', fn: 'custom', typeArg: type, args: [{ code: `(v) => ${checks}.safeParse(v).success` }] };
  }

  /** One branch per implied type, and every value of another type passes. */
  private typelessChecks(schema: Json, implied: JsonType[], scope: Scope): ZodNode {
    const others = implied.map((t) => `(${GUARDS[t]})`).join(' || ');
    const rest: ZodNode = { kind: 'call', fn: 'custom', typeArg: 'never', args: [{ code: `(v) => !(${others})` }] };
    return this.union([...implied.map((t) => this.branch(t, schema, scope)), rest]);
  }

  /** Nodes to declare before the declaration that reads them, as `const _checkN = ...`. */
  public takeHoisted(): { name: string; node: ZodNode }[] {
    return this.hoisted.splice(0);
  }

  private hoist(node: ZodNode, scope: Scope): string {
    const name = `${HOIST_PREFIX[scope.variant ?? 'request']}${++this.hoistedCount}`;
    this.hoisted.push({ name, node });
    return name;
  }

  private branch(type: JsonType, schema: Json, scope: Scope): ZodNode {
    switch (type) {
      case 'string':
        return { ...call('string'), checks: this.stringChecks(schema, scope) };
      case 'number':
      case 'integer': {
        const integer: Check = { kind: 'refine', fn: 'Number.isInteger', message: 'must be integer' };
        return { ...call('number'), checks: [...(type === 'integer' ? [integer] : []), ...this.numberChecks(schema, scope)] };
      }
      case 'array':
        return this.array(schema, scope);
      case 'object':
        return this.object(schema, scope);
      default:
        return call(type);
    }
  }

  private limit(schema: Json, key: string, scope: Scope): number | undefined {
    const value = schema[key];
    if (value === undefined || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (isDataRef(value)) return undefined;
    this.diagnostics.report('ZOD001', child(scope.at, key), `'${key}' must be a number; it is dropped`);
    return undefined;
  }

  private stringChecks(schema: Json, scope: Scope): Check[] {
    const checks: Check[] = [];
    const min = this.limit(schema, 'minLength', scope);
    const max = this.limit(schema, 'maxLength', scope);
    if (min !== undefined) checks.push({ kind: 'refine', fn: `${this.format('minCodePoints')}(${min})`, message: `must NOT have fewer than ${min} characters` });
    if (max !== undefined) checks.push({ kind: 'refine', fn: `${this.format('maxCodePoints')}(${max})`, message: `must NOT have more than ${max} characters` });
    checks.push(...regexpCheck(schema, this.host(scope)));
    if (typeof schema.pattern === 'string') {
      if (this.validPattern(schema.pattern)) checks.push({ kind: 'regex', source: schema.pattern });
      else this.diagnostics.report('ZOD001', child(scope.at, 'pattern'), 'pattern is not a valid regular expression with the u flag; it is dropped');
    }
    const name = typeof schema.format === 'string' ? schema.format : undefined;
    if (name !== undefined && formats.formatPredicate(name) && !UNCHECKED_FORMATS.has(name)) {
      checks.push({ kind: 'refine', fn: this.format(formatExport(name)), message: `must match format "${name}"` });
    }
    this.unknownFormat(schema, scope);
    return checks;
  }

  private validPattern(pattern: string): boolean {
    try {
      return new RegExp(pattern, 'u') instanceof RegExp;
    } catch {
      return false;
    }
  }

  private numberChecks(schema: Json, scope: Scope): Check[] {
    const checks: Check[] = [];
    for (const [key, kind] of [['minimum', 'gte'], ['maximum', 'lte'], ['exclusiveMinimum', 'gt'], ['exclusiveMaximum', 'lt']] as const) {
      const value = this.limit(schema, key, scope);
      if (value !== undefined) checks.push({ kind, value });
    }
    checks.push(...rangeChecks(schema, this.host(scope)));
    const multipleOf = this.limit(schema, 'multipleOf', scope);
    if (multipleOf !== undefined) checks.push({ kind: 'refine', fn: `${this.format('ajvMultipleOf')}(${multipleOf})`, message: `must be multiple of ${multipleOf}` });
    const name = typeof schema.format === 'string' ? schema.format : undefined;
    if (name !== undefined && formats.numberFormatPredicate(name) && !UNCHECKED_FORMATS.has(name)) {
      checks.push({ kind: 'refine', fn: this.format(formatExport(name)), message: `must match format "${name}"` });
    }
    this.unknownFormat(schema, scope);
    return checks;
  }

  private unknownFormat(schema: Json, scope: Scope): void {
    const name = schema.format;
    if (name === undefined || (typeof name === 'string' && (formats.formatPredicate(name) || formats.numberFormatPredicate(name)))) return;
    this.diagnostics.report('ZOD002', child(scope.at, 'format'), `format ${JSON.stringify(name)} is unknown to the server's Ajv, which accepts every value; so does the schema`);
  }

  /** A `@spinajs/client/formats` export, imported by the file. */
  public format(name: string): string {
    if (typeof (formats as Record<string, unknown>)[name] !== 'function') throw new Error(`generateClient: @spinajs/client/formats has no export '${name}'`);
    this.formats.add(name);
    return name;
  }

  private array(schema: Json, scope: Scope): ZodNode {
    const prefix = Array.isArray(schema.items) ? schema.items : [];
    const restSchema = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
    const max = this.limit(schema, 'maxItems', scope);
    const shape = arrayShape(prefix.length, restSchema !== false, this.limit(schema, 'minItems', scope) ?? 0, max);
    const items = prefix.map((m, i) => this.slot(m, shape.uses[i], { ...scope, at: child(scope.at, 'items', i) }));
    const restAt = child(scope.at, Array.isArray(schema.items) ? 'additionalItems' : 'items');
    const rest = restSchema === false || shape.restUses === 0 ? undefined : this.slot(restSchema, shape.restUses, { ...scope, at: restAt });
    const node = this.lengths(items, rest, shape, max);
    return this.arrayKeywords(node, schema, scope);
  }

  private arrayKeywords(node: ZodNode, schema: Json, scope: Scope): ZodNode {
    const unique = schema.uniqueItems === true ? this.uniqueItems(schema, scope) : undefined;
    const checks = [...(node.checks ?? []), ...arrayChecks(schema, this.host(scope)), ...(unique && !unique.asSent ? [unique.check] : [])];
    const input = unique?.asSent ? [...(node.inputChecks ?? []), unique.check] : node.inputChecks;
    return { ...node, ...(checks.length ? { checks } : {}), ...(input?.length ? { inputChecks: input } : {}) };
  }

  // A slot printed in several tuples is declared once, outside any getter, as the hoisted const is read at module load.
  private slot(schema: unknown, uses: number, scope: Scope): ZodNode {
    const inner: Scope = { ...scope, typePath: undefined };
    if (schema === undefined) return UNKNOWN;
    if (uses <= 1 || isSimple(schema)) return this.node(schema, inner);
    return { kind: 'ref', name: this.hoist(this.node(schema, { ...inner, deferred: false }), scope) };
  }

  // Ajv checks only the positions present. client.ts types a bounded array as a union of tuples, as
  // json-schema-to-typescript does, so the schema is that union too.
  private lengths(items: ZodNode[], rest: ZodNode | undefined, shape: ArrayShape, max: number | undefined): ZodNode {
    const tuple = (length: number): ZodNode => call('tuple', { list: Array.from({ length }, (_, i) => items[i] ?? rest ?? UNKNOWN) });
    const range = (from: number, to: number): ZodNode[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => tuple(from + i));
    if (shape.kind === 'exact') return this.union(range(shape.from, shape.to));
    if (shape.kind === 'array') return { ...call('array', { node: rest ?? UNKNOWN }), checks: max === undefined ? [] : [{ kind: 'maxItems', value: max }] };
    return this.union([...range(shape.from, items.length - 1), this.openTuple(items, rest ?? UNKNOWN, shape.fixed, max)]);
  }

  /** At least `fixed` items, the ones after the prefix checked by `rest`. */
  private openTuple(items: ZodNode[], rest: ZodNode, fixed: number, max: number | undefined): ZodNode {
    const leading = Array.from({ length: fixed }, (_, i) => items[i] ?? rest);
    const checks: Check[] = max === undefined ? [] : [{ kind: 'refine', fn: `(a) => a.length <= ${max}`, message: `must NOT have more than ${max} items` }];
    return { ...call('tuple', { list: leading }, { node: rest }), checks };
  }

  /**
   * A loose object item parses without an own `__proto__` key, which Ajv compares, so such items are compared as sent.
   * Other items are compared parsed, which keeps the array's input type.
   */
  private uniqueItems(schema: Json, scope: Scope): { check: Check; asSent: boolean } {
    const slots = Array.isArray(schema.items) ? [...(schema.items as unknown[]), schema.additionalItems] : [schema.items];
    const asSent = slots.some((slot) => this.mayBeLooseObject(slot, scope.at.schema));
    const fn = asSent ? `(a) => !Array.isArray(a) || ${this.format('ajvUniqueItems')}(a)` : this.format('ajvUniqueItems');
    return { check: { kind: 'refine', fn, message: 'must NOT have duplicate items' }, asSent };
  }

  // Unless the schema says otherwise: a typed non-object, a closed object, or a $ref to one.
  private mayBeLooseObject(schema: unknown, owner: string, depth = 0): boolean {
    if (schema === false) return false;
    if (!isJson(schema) || depth > 8 || has(schema, ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'enum', 'const'])) return true;
    if (typeof schema.$ref === 'string') {
      const entry = this.graph.get(this.graph.resolve(schema.$ref, owner) ?? '');
      if (!entry || this.mayBeLooseObject(entry.schema, entry.owner, depth + 1)) return true;
    }
    const types: unknown[] = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
    if (types.length === 0) return typeof schema.$ref !== 'string';
    return types.includes('object') && (schema.additionalProperties !== false || isJson(schema.patternProperties));
  }

  private object(schema: Json, scope: Scope): ZodNode {
    const data = dataChecks(ownProperties(schema), scope.at, (name) => this.format(name), this.dataHandled);
    const node = this.plainObject(schema, scope);
    return data.length ? { ...node, checks: [...(node.checks ?? []), ...data] } : node;
  }

  private plainObject(schema: Json, scope: Scope): ZodNode {
    const required = requiredOf(schema);
    const properties = Object.entries(ownProperties(schema)).map(([name, value]) => {
      return this.property(name, [{ schema: value, at: child(scope.at, 'properties', name) }], required.includes(name), scope);
    });
    const checks = this.requiredChecks(required, properties);
    if (isJson(schema.patternProperties)) return { kind: 'object', mode: 'loose', properties, catchall: this.patternCatchall(schema), checks };
    const additional = schema.additionalProperties;
    const catchall = isJson(additional) ? this.node(additional, { ...scope, typePath: undefined, at: child(scope.at, 'additionalProperties') }) : undefined;
    const node: ZodNode = { kind: 'object', mode: additional === false ? this.closed(checks, scope) : 'loose', properties, ...(catchall && catchall !== UNKNOWN ? { catchall } : {}) };
    return { ...node, checks };
  }

  // A reply drops what the server's closed object would reject, unless a check reads the parsed value and needs the keys.
  private closed(checks: Check[], scope: Scope): 'strict' | 'strip' | 'loose' {
    if (scope.variant !== 'reply') return 'strict';
    return checks.length > 0 ? 'loose' : 'strip';
  }

  // `additionalProperties` does not apply to keys `patternProperties` matches. Until that keyword is mapped, other keys
  // accept anything, typed as client.ts types them.
  private patternCatchall(schema: Json): ZodNode {
    const values = [...Object.values(schema.patternProperties as Json), ...(isJson(schema.additionalProperties) ? [schema.additionalProperties] : [])];
    return { kind: 'call', fn: 'custom', typeArg: [...new Set(values.map((v) => this.typeOf(v)))].join(' | '), acceptsUndefined: true };
  }

  /** A property, whose schema may come from several `allOf` members; a getter when it reads its own declaration's cycle. */
  private property(name: string, sources: { schema: unknown; at: Location }[], required: boolean, scope: Scope): Property {
    const getter = !scope.deferred && sources.some((s) => this.readsCycle(s.schema, s.at.schema, scope.current));
    const member = scope.typePath === undefined ? undefined : `${scope.typePath}[${literal(name)}]`;
    const objectLike = sources.length === 1 && isJson(sources[0].schema) && !has(sources[0].schema, ['allOf', 'anyOf', 'oneOf', '$ref', 'enum', 'const']);
    const inner: Scope = { ...scope, deferred: scope.deferred || getter, typePath: member && objectLike ? `NonNullable<${member}>` : undefined };
    const built = sources.map((s) => this.node(s.schema, { ...inner, at: s.at })).reduce((a, b) => call('intersection', { node: a }, { node: b }));
    const node = this.dataConstTyped(built, sources, member, inner);
    if (!getter) return { key: name, node, optional: !required };
    // The interface's own member type cannot disagree with client.ts; a hoisted definition has no interface.
    const type = member === undefined ? sources.map((s) => this.typeOf(s.schema)).join(' & ') : required ? member : `Exclude<${member}, undefined>`;
    return { key: name, node, optional: !required, getter: type };
  }

  /**
   * client.ts types `const: { $data }` as that object, which no value the server accepts is. Such a property is typed
   * as client.ts types it, and its own schema is a check; the `$data` comparison sits on the parent object.
   */
  private dataConstTyped(node: ZodNode, sources: { schema: unknown }[], member: string | undefined, scope: Scope): ZodNode {
    if (!sources.some((s) => isJson(s.schema) && isDataRef(s.schema.const))) return node;
    const type = member ?? sources.map((s) => this.typeOf(s.schema)).join(' & ');
    const check: Check = { kind: 'refine', fn: `(v) => ${use(0)}.safeParse(v).success`, uses: [this.usable(node, scope)], message: 'must match the schema of the property' };
    return { kind: 'call', fn: 'custom', typeArg: type, checks: [check], acceptsUndefined: true };
  }

  private readsCycle(schema: unknown, owner: string, current: string | undefined): boolean {
    return refsIn(schema).some((ref) => {
      const key = this.graph.resolve(ref, owner);
      return key !== undefined && this.graph.cyclic(current, key);
    });
  }

  // zod 4.1 lets a key be missing when its schema accepts `undefined`, and a required key need not be declared at all.
  private requiredChecks(required: string[], properties: Property[]): Check[] {
    return required
      .filter((name) => {
        const declared = properties.find((p) => p.key === name);
        return !declared || declared.node.acceptsUndefined;
      })
      // Ajv's `required` reads the property, inherited ones included: `{}` has a `toString`.
      .map((name) => ({ kind: 'refine', fn: `(o) => Reflect.get(o, ${literal(name)}) !== undefined`, message: `must have required property '${name}'` }));
  }

  /**
   * `ManifestSchemaPreparer.intersection`: when every member is a closed object, the intersection accepts the union of
   * their property names, and a name a member declares stands for `true` in the node's own `properties`.
   */
  private mergedAllOf(schema: Json, scope: Scope): ZodNode | undefined {
    const shape = this.closedShape(schema, scope.at, new Set());
    if (!shape) return undefined;
    const properties = [...shape.properties].map(([name, sources]) => this.property(name, sources, shape.required.has(name), scope));
    // Each member is still validated on its own, opened: its other keywords apply to the merged object.
    const input = shape.members.flatMap((m) => inputChecks(withoutKey(m.schema, 'additionalProperties'), this.host({ ...scope, at: m.at, typePath: undefined })));
    const checks = this.requiredChecks([...shape.required], properties);
    return { kind: 'object', mode: this.closed(checks, scope), properties, checks, ...(input.length ? { inputChecks: input } : {}) };
  }

  // The server checks `anyOf`/`oneOf` on the members it merges, not on the `allOf` node itself.
  private closedShape(schema: Json, at: Location, seen: Set<string>, top = true): ClosedShape | undefined {
    // With its own patternProperties the merged node accepts the keys they match, which a strict object cannot.
    if (!Array.isArray(schema.allOf) || (!top && has(schema, ['anyOf', 'oneOf'])) || isJson(schema.patternProperties)) return undefined;
    const shape: ClosedShape = { properties: new Map(), required: new Set(requiredOf(schema)), members: [] };
    for (const [i, member] of schema.allOf.entries()) {
      const target = this.target(member, child(at, 'allOf', i), seen);
      const inner = target && (this.closedShape(target.schema, target.at, target.seen, false) ?? this.closedObject(target.schema, target.at));
      if (!inner) return undefined;
      this.reportUnmapped(target.schema, { at: target.at });
      shape.members.push(...inner.members);
      for (const [name, sources] of inner.properties) shape.properties.set(name, [...(shape.properties.get(name) ?? []), ...sources]);
      inner.required.forEach((name) => shape.required.add(name));
    }
    for (const [name, value] of Object.entries(ownProperties(schema))) {
      if (!shape.properties.has(name)) shape.properties.set(name, [{ schema: value, at: child(at, 'properties', name) }]);
    }
    for (const [name, sources] of shape.properties) shape.properties.set(name, [...new Map(sources.map((s) => [`${s.at.schema} ${JSON.stringify(s.schema)}`, s])).values()]);
    return shape;
  }

  private target(member: unknown, at: Location, seen: Set<string>): { schema: Json; at: Location; seen: Set<string> } | undefined {
    if (!isJson(member)) return undefined;
    if (typeof member.$ref !== 'string' || Object.keys(member).length !== 1) return { schema: member, at, seen };
    const key = this.graph.resolve(member.$ref, at.schema);
    const entry = key === undefined || seen.has(key) ? undefined : this.graph.get(key);
    if (!entry || !isJson(entry.schema) || isPartial(entry.schema)) return undefined;
    return { schema: entry.schema, at: { schema: entry.owner, pointer: entry.pointer }, seen: new Set([...seen, entry.key]) };
  }

  private closedObject(schema: Json, at: Location): ClosedShape | undefined {
    if (schema.additionalProperties !== false || !isJson(schema.properties) || has(schema, ['anyOf', 'oneOf'])) return undefined;
    const properties = new Map(Object.entries(schema.properties).map(([name, value]) => [name, [{ schema: value, at: child(at, 'properties', name) }]]));
    return { properties, required: new Set(requiredOf(schema)), members: [{ schema, at }] };
  }
}

interface ClosedShape {
  properties: Map<string, { schema: unknown; at: Location }[]>;
  required: Set<string>;
  /** The closed objects merged. */
  members: { schema: Json; at: Location }[];
}
