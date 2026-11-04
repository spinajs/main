import * as formats from '../../formats/index.js';
import { literal, propertyKey, type TypeContext } from '../ts-type.js';
import { child, type Diagnostics, type Location } from './diagnostics.js';
import { call, UNKNOWN, type Check, type Property, type ZodNode } from './print.js';
import { isJson, isPartial, refsIn, type Json, type SchemaGraph } from './refs.js';

/** Where the builder is: the node's location, the declaration it belongs to, and whether a getter already defers it. */
export interface Scope {
  at: Location;
  /** The key of the declaration being built; undefined for a schema printed inline. */
  current?: string;
  deferred?: boolean;
  /** Set when the declaration reads itself through `z.lazy`, which needs an explicit type. */
  state?: { annotated: boolean };
}

// Keywords whose mapping is not written yet, or cannot be: dropping one makes the schema looser than the server.
const UNMAPPED = new Set([
  'not', 'if', 'contains', 'patternProperties', 'propertyNames', 'dependencies', 'dependentRequired', 'dependentSchemas', 'minProperties', 'maxProperties',
  'unevaluatedProperties', 'unevaluatedItems', '$merge', '$patch', '$async', 'formatMinimum', 'formatMaximum', 'formatExclusiveMinimum', 'formatExclusiveMaximum',
  'instanceof', 'range', 'exclusiveRange', 'regexp', 'transform', 'uniqueItemProperties', 'select', 'dynamicDefaults', 'typeof', 'allRequired', 'anyRequired',
  'oneRequired', 'patternRequired', 'prohibited', 'deepProperties', 'deepRequired',
]);

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

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
// json-schema-to-typescript's default `maxItems`: the longest bounded array it still writes as a union of tuples.
const MAX_TUPLE_ITEMS = 20;
// Ajv accepts these strings without a check.
const UNCHECKED_FORMATS = new Set(['password', 'binary', 'float', 'double']);

const has = (schema: Json, keys: string[]): boolean => keys.some((k) => k in schema);

const ownProperties = (schema: Json): Json => (isJson(schema.properties) ? schema.properties : {});

const requiredOf = (schema: Json): string[] => (Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);

const acceptsAnything = (schema: unknown): boolean =>
  schema === true || isPartial(schema) || (isJson(schema) && Object.keys(schema).every((k) => k.startsWith('$') || k.startsWith('x-') || k === 'description' || k === 'title'));

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

// A `__proto__` key in an object literal sets the prototype instead of defining a property.
function valueCode(value: unknown): string {
  const json = JSON.stringify(value);
  return json.includes('"__proto__"') ? `JSON.parse(${literal(json)})` : json;
}

/** Turns manifest JSON Schema nodes into zod nodes, as `ManifestValidator`'s Ajv validates them. */
export class ZodBuilder {
  /** Names imported from `@spinajs/client/formats`. */
  public readonly formats = new Set<string>();
  public readonly helpers = new Set<'oneOf'>();
  private readonly hoisted: { name: string; node: ZodNode }[] = [];
  private hoistedCount = 0;

  constructor(
    private readonly graph: SchemaGraph,
    private readonly ctx: TypeContext,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** A whole manifest schema, or a local definition hoisted out of one. */
  public root(schema: unknown, scope: Scope): ZodNode {
    if (isJson(schema) && typeof schema.$schema === 'string' && !DRAFT_07.test(schema.$schema)) {
      this.diagnostics.report('ZOD001', scope.at, `Ajv refuses $schema '${schema.$schema}'; the server does not validate this schema, and it accepts any value`);
      return UNKNOWN;
    }
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
    const parts = this.parts(schema, scope);
    const node = parts.length === 0 ? UNKNOWN : parts.reduce((a, b) => call('intersection', { node: a }, { node: b }));
    return typeof schema.description === 'string' ? { ...node, description: schema.description } : node;
  }

  /** The TypeScript type of `schema`'s values, as `client.ts` declares it; for a getter's annotation. */
  public typeOf(schema: unknown): string {
    const declared = refsIn(schema).every((ref) => ref.startsWith('#') || !this.ctx.schemaOf(ref) || this.ctx.used.has(ref));
    return declared ? this.ctx.expression(schema) : 'unknown';
  }

  // Ajv applies every keyword of a node: each group becomes one part, and the parts are intersected.
  private parts(schema: Json, scope: Scope): ZodNode[] {
    if ('const' in schema) return [this.constant(schema.const)];
    const parts: ZodNode[] = [];
    let objectDone = false;
    if (Array.isArray(schema.allOf)) {
      const merged = this.mergedAllOf(schema, scope);
      objectDone = merged !== undefined;
      parts.push(...(merged ? [merged] : schema.allOf.map((m, i) => this.node(m, { ...scope, at: child(scope.at, 'allOf', i) }))));
    }
    if (typeof schema.$ref === 'string') parts.push(this.ref(schema.$ref, scope));
    if (Array.isArray(schema.enum)) parts.push(this.enumeration(schema.enum));
    if (!objectDone && (!Array.isArray(schema.enum) || has(schema, [...STRING_KEYWORDS, ...NUMBER_KEYWORDS, ...ARRAY_KEYWORDS, ...OBJECT_KEYWORDS, 'format']))) {
      const typed = this.typed(schema, scope);
      if (typed) parts.push(typed);
    }
    if (Array.isArray(schema.anyOf)) parts.push(this.anyOf(schema.anyOf, scope));
    if (Array.isArray(schema.oneOf)) parts.push(this.oneOf(schema, schema.oneOf, scope));
    return parts;
  }

  private reportUnmapped(schema: Json, scope: Scope): void {
    for (const key of Object.keys(schema)) {
      if (UNMAPPED.has(key)) this.diagnostics.report('ZOD003', child(scope.at, key), `keyword '${key}' is not mapped and is dropped; the schema accepts more than the server`);
    }
  }

  private ref(ref: string, scope: Scope): ZodNode {
    const key = this.graph.resolve(ref, scope.at.schema);
    const entry = key === undefined ? undefined : this.graph.get(key);
    if (!key || !entry) {
      this.diagnostics.report('ZOD001', child(scope.at, '$ref'), `$ref '${ref}' is not a schema of the manifest; this node accepts any value`);
      return UNKNOWN;
    }
    const acceptsUndefined = acceptsAnything(entry.schema);
    if (this.graph.cyclic(scope.current, key) && !scope.deferred) {
      if (scope.state) scope.state.annotated = true;
      return { ...call('lazy', { lazy: entry.name }), acceptsUndefined };
    }
    return { kind: 'ref', name: entry.name, acceptsUndefined };
  }

  private constant(value: unknown): ZodNode {
    if (value === null) return call('null');
    if (typeof value !== 'object') return call('literal', { code: literal(value) });
    return { kind: 'call', fn: 'custom', typeArg: valueType(value), args: [{ code: `(v) => ${this.format('ajvEqual')}(v, ${valueCode(value)})` }, { code: literal('must be equal to constant') }] };
  }

  private enumeration(values: unknown[]): ZodNode {
    const unique = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];
    if (unique.length === 0) return call('never');
    if (unique.every((v) => typeof v === 'string')) return call('enum', { code: `[${unique.map(literal).join(', ')}]` });
    if (unique.every((v) => v === null || typeof v !== 'object')) return unique.length === 1 ? this.constant(unique[0]) : call('literal', { code: `[${unique.map(literal).join(', ')}]` });
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
    return this.union(nodes.map((n) => n.node()));
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
    this.helpers.add('oneOf');
    return { kind: 'call', fn: 'oneOf', helper: true, args: [{ list: nodes }] };
  }

  // `x-discriminator` comes only with `$ref` members that each fix the property to a literal; a lazy member cannot be told apart.
  private discriminator(schema: Json, members: unknown[], nodes: ZodNode[], owner: string): string | undefined {
    const spec = schema['x-discriminator'];
    const property = isJson(spec) && typeof spec.propertyName === 'string' ? spec.propertyName : undefined;
    if (property === undefined || nodes.some((n) => n.kind !== 'ref')) return undefined;
    const objects = members.every((m) => {
      const target = isJson(m) && typeof m.$ref === 'string' ? this.graph.get(this.graph.resolve(m.$ref, owner) ?? '')?.schema : undefined;
      const tag = isJson(target) ? ownProperties(target)[property] : undefined;
      return isJson(target) && target.type === 'object' && !has(target, ['allOf', 'anyOf', 'oneOf', '$ref']) && isJson(tag) && ('const' in tag || Array.isArray(tag.enum));
    });
    return objects ? property : undefined;
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
    if (others.length === 1 && others.length < types.length) return { ...this.branch(others[0], schema, scope), nullable: true };
    return this.union(types.map((t) => this.branch(t, schema, scope)));
  }

  // Without `type`, a keyword checks only values of its own type, and every other value passes.
  private untyped(schema: Json, scope: Scope): ZodNode | undefined {
    const implied = TYPES.filter((t) => {
      if (t === 'string') return has(schema, STRING_KEYWORDS) || (typeof schema.format === 'string' && formats.formatPredicate(schema.format) !== undefined);
      if (t === 'number') return has(schema, NUMBER_KEYWORDS) || (typeof schema.format === 'string' && formats.numberFormatPredicate(schema.format) !== undefined);
      return (t === 'array' && has(schema, ARRAY_KEYWORDS)) || (t === 'object' && has(schema, OBJECT_KEYWORDS));
    });
    this.unknownFormat(schema, scope);
    const checked = (deferred: boolean): ZodNode => {
      const rest: ZodNode = { kind: 'call', fn: 'custom', typeArg: 'never', args: [{ code: `(v) => !(${implied.map((t) => `(${GUARDS[t]})`).join(' || ')})` }] };
      return this.union([...implied.map((t) => this.branch(t, schema, { ...scope, deferred })), rest]);
    };
    if (has(schema, ['$ref', 'allOf', 'anyOf', 'oneOf', 'enum', 'const']) || (implied.length > 0 && implied.every((t) => t === 'object' || (t === 'array' && 'items' in schema)))) {
      return implied.length ? checked(scope.deferred ?? false) : undefined;
    }
    if (!Object.keys(schema).some((k) => !k.startsWith('x-') && !['$id', '$schema', 'title'].includes(k))) return undefined;
    // client.ts types this node as json-schema-to-typescript does: by the type of its `default`, else as an open object.
    const type = ['string', 'number', 'boolean'].includes(typeof schema.default) ? typeof schema.default : '{ [k: string]: unknown }';
    if (implied.length === 0) return { kind: 'call', fn: 'custom', typeArg: type, acceptsUndefined: true };
    // Built outside any getter: the hoisted const is evaluated when the module loads.
    return { kind: 'call', fn: 'custom', typeArg: type, args: [{ code: `(v) => ${this.hoist(checked(false))}.safeParse(v).success` }] };
  }

  /** Nodes to declare before the declaration that reads them, as `const _checkN = ...`. */
  public takeHoisted(): { name: string; node: ZodNode }[] {
    return this.hoisted.splice(0);
  }

  private hoist(node: ZodNode): string {
    const name = `_check${++this.hoistedCount}`;
    this.hoisted.push({ name, node });
    return name;
  }

  private branch(type: JsonType, schema: Json, scope: Scope): ZodNode {
    switch (type) {
      case 'string':
        return { ...call('string'), checks: this.stringChecks(schema, scope) };
      case 'number':
      case 'integer':
        return { ...call('number'), checks: [...(type === 'integer' ? [{ kind: 'refine' as const, fn: 'Number.isInteger', message: 'must be integer' }] : []), ...this.numberChecks(schema, scope)] };
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
    if (isJson(value) && '$data' in value) this.diagnostics.report('ZOD003', child(scope.at, key), `$data in '${key}' is not mapped and is dropped; the schema accepts more than the server`);
    else this.diagnostics.report('ZOD001', child(scope.at, key), `'${key}' must be a number; Ajv refuses the schema, and the keyword is dropped`);
    return undefined;
  }

  private stringChecks(schema: Json, scope: Scope): Check[] {
    const checks: Check[] = [];
    const min = this.limit(schema, 'minLength', scope);
    const max = this.limit(schema, 'maxLength', scope);
    if (min !== undefined) checks.push({ kind: 'refine', fn: `${this.format('minCodePoints')}(${min})`, message: `must NOT have fewer than ${min} characters` });
    if (max !== undefined) checks.push({ kind: 'refine', fn: `${this.format('maxCodePoints')}(${max})`, message: `must NOT have more than ${max} characters` });
    if (typeof schema.pattern === 'string') {
      if (this.validPattern(schema.pattern)) checks.push({ kind: 'regex', source: schema.pattern });
      else this.diagnostics.report('ZOD001', child(scope.at, 'pattern'), 'pattern is not a valid regular expression with the u flag; Ajv refuses the schema, and the pattern is dropped');
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

  private format(name: string): string {
    if (typeof (formats as Record<string, unknown>)[name] !== 'function') throw new Error(`generateClient: @spinajs/client/formats has no export '${name}'`);
    this.formats.add(name);
    return name;
  }

  private array(schema: Json, scope: Scope): ZodNode {
    const prefix = Array.isArray(schema.items) ? schema.items.map((m, i) => this.node(m, { ...scope, at: child(scope.at, 'items', i) })) : [];
    const node = this.lengths(prefix, this.rest(schema, scope), this.limit(schema, 'minItems', scope) ?? 0, this.limit(schema, 'maxItems', scope));
    return schema.uniqueItems === true ? { ...node, checks: [...(node.checks ?? []), this.uniqueItems(schema)] } : node;
  }

  /** The schema of the items after the tuple prefix; undefined when there may be none. */
  private rest(schema: Json, scope: Scope): ZodNode | undefined {
    if (!Array.isArray(schema.items)) return schema.items === undefined ? UNKNOWN : this.node(schema.items, { ...scope, at: child(scope.at, 'items') });
    if (schema.additionalItems === false) return undefined;
    return schema.additionalItems === undefined ? UNKNOWN : this.node(schema.additionalItems, { ...scope, at: child(scope.at, 'additionalItems') });
  }

  // Ajv checks only the positions present. client.ts types a bounded array as a union of tuples, as
  // json-schema-to-typescript does, so the schema is that union too.
  private lengths(prefix: ZodNode[], rest: ZodNode | undefined, min: number, max: number | undefined): ZodNode {
    const tuple = (length: number): ZodNode => call('tuple', { list: Array.from({ length }, (_, i) => prefix[i] ?? rest ?? UNKNOWN) });
    const longest = rest ? max : Math.min(max ?? prefix.length, prefix.length);
    if (longest !== undefined && (!rest || longest <= MAX_TUPLE_ITEMS)) return this.union(Array.from({ length: Math.max(0, longest - min + 1) }, (_, i) => tuple(min + i)));
    const bound: Check[] = max === undefined ? [] : [{ kind: 'maxItems', value: max }];
    if (prefix.length === 0 && min === 0) return { ...call('array', { node: rest ?? UNKNOWN }), checks: bound };
    const fixed = Math.max(min, prefix.length);
    const shorter = Array.from({ length: Math.max(0, prefix.length - min) }, (_, i) => tuple(min + i));
    const open: ZodNode = { ...call('tuple', { list: Array.from({ length: fixed }, (_, i) => prefix[i] ?? rest ?? UNKNOWN) }, { node: rest ?? UNKNOWN }), checks: max === undefined ? [] : [{ kind: 'refine', fn: `(a) => a.length <= ${max}`, message: `must NOT have more than ${max} items` }] };
    return this.union([...shorter, open]);
  }

  private uniqueItems(schema: Json): Check {
    const items = isJson(schema.items) ? schema.items : undefined;
    const types = items && (typeof items.type === 'string' || Array.isArray(items.type)) ? [...new Set([items.type, items.nullable === true ? 'null' : []].flat())] : undefined;
    return { kind: 'refine', fn: types ? `(a) => ${this.format('ajvUniqueItems')}(a, ${JSON.stringify(types)})` : this.format('ajvUniqueItems'), message: 'must NOT have duplicate items' };
  }

  private object(schema: Json, scope: Scope): ZodNode {
    const required = requiredOf(schema);
    const properties = Object.entries(ownProperties(schema)).map(([name, value]) => this.property(name, [{ schema: value, at: child(scope.at, 'properties', name) }], required.includes(name), scope));
    if (isJson(schema.patternProperties)) return { kind: 'object', mode: 'loose', properties, catchall: this.patternCatchall(schema), checks: this.requiredChecks(required, properties) };
    const additional = schema.additionalProperties;
    const catchall = isJson(additional) ? this.node(additional, { ...scope, at: child(scope.at, 'additionalProperties') }) : undefined;
    const node: ZodNode = { kind: 'object', mode: additional === false ? 'strict' : 'loose', properties, ...(catchall && catchall !== UNKNOWN ? { catchall } : {}) };
    return { ...node, checks: this.requiredChecks(required, properties) };
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
    const inner: Scope = { ...scope, deferred: scope.deferred || getter };
    const node = sources.map((s) => this.node(s.schema, { ...inner, at: s.at })).reduce((a, b) => call('intersection', { node: a }, { node: b }));
    return { key: name, node, optional: !required, ...(getter ? { getter: sources.map((s) => this.typeOf(s.schema)).join(' & ') } : {}) };
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
      .map((name) => ({ kind: 'refine', fn: `(o) => Object.hasOwn(o, ${literal(name)})`, message: `must have required property '${name}'` }));
  }

  /**
   * `ManifestSchemaPreparer.intersection`: when every member is a closed object, the intersection accepts the union of
   * their property names, and a name a member declares stands for `true` in the node's own `properties`.
   */
  private mergedAllOf(schema: Json, scope: Scope): ZodNode | undefined {
    const shape = this.closedShape(schema, scope.at, new Set());
    if (!shape) return undefined;
    const properties = [...shape.properties].map(([name, sources]) => this.property(name, sources, shape.required.has(name), scope));
    return { kind: 'object', mode: 'strict', properties, checks: this.requiredChecks([...shape.required], properties) };
  }

  private closedShape(schema: Json, at: Location, seen: Set<string>): ClosedShape | undefined {
    if (!Array.isArray(schema.allOf) || has(schema, ['anyOf', 'oneOf'])) return undefined;
    const shape: ClosedShape = { properties: new Map(), required: new Set(requiredOf(schema)) };
    for (const [i, member] of schema.allOf.entries()) {
      const target = this.target(member, child(at, 'allOf', i), seen);
      const inner = target && (this.closedShape(target.schema, target.at, target.seen) ?? this.closedObject(target.schema, target.at));
      if (!inner) return undefined;
      if (target.schema !== member) this.reportUnmapped(target.schema, { at: target.at });
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
    return { properties, required: new Set(requiredOf(schema)) };
  }
}

interface ClosedShape {
  properties: Map<string, { schema: unknown; at: Location }[]>;
  required: Set<string>;
}
