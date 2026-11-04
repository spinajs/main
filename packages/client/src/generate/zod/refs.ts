import type { TypeContext } from '../ts-type.js';
import { compare } from './diagnostics.js';

export type Json = Record<string, unknown>;

export const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The server validates an `x-explicit: 'partial'` schema as `{}`: the analyzer could not read the explicit `@Schema`. */
export const isPartial = (schema: unknown): boolean => isJson(schema) && schema['x-explicit'] === 'partial';

// Keys whose members are schemas by name: a property called `$ref` is data.
const NAMED = new Set(['properties', 'patternProperties', 'dependentSchemas']);
// Values that are data, or schemas only reached through a `$ref`.
const NOT_WALKED = new Set(['const', 'enum', 'default', 'examples', '$defs', 'definitions']);

/** Every `$ref` string in `schema`, in document order. */
export function refsIn(schema: unknown, named = false, found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) refsIn(item, false, found);
    return found;
  }
  if (!isJson(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (named) refsIn(value, false, found);
    else if (key === '$ref' && typeof value === 'string') found.push(value);
    else if (!key.startsWith('x-') && !NOT_WALKED.has(key)) refsIn(value, NAMED.has(key), found);
  }
  return found;
}

function sanitize(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

const LOCAL = /^#\/(\$defs|definitions)\/([^/]+)$/;

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;
// Values that are data, not schemas, so the meta-schema rules do not read them. A merge patch's `with` and the
// ajv-keywords arguments are checked by their plugin, not by the draft-07 meta-schema.
const DATA = new Set([
  'const', 'enum', 'default', 'examples', '$merge', '$patch', 'regexp', 'transform', 'range', 'exclusiveRange', 'dynamicDefaults', 'select', 'selectCases', 'selectDefault',
]);

function validPattern(pattern: string): boolean {
  try {
    return new RegExp(pattern, 'u') instanceof RegExp;
  } catch {
    return false;
  }
}

// `{ $data }` stands for a number in the keywords that take one: `DataValidator` builds Ajv with `$data: true`.
const isDataRef = (value: unknown): boolean => isJson(value) && typeof value.$data === 'string' && Object.keys(value).length === 1;
const isNumber = (value: unknown): boolean => (typeof value === 'number' && Number.isFinite(value)) || isDataRef(value);
const isCount = (value: unknown): boolean => (Number.isInteger(value) && (value as number) >= 0) || isDataRef(value);
const isSchema = (value: unknown): boolean => isJson(value) || typeof value === 'boolean';
const distinct = (values: unknown[]): boolean => new Set(values.map((v) => JSON.stringify(v))).size === values.length;
const isTypeList = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && distinct(value) && value.every((t) => typeof t === 'string' && JSON_TYPES.has(t));
const isNames = (value: unknown): boolean => Array.isArray(value) && value.every((v) => typeof v === 'string') && distinct(value);

/** The draft-07 meta-schema rules of the keywords the emitter reads: a schema that breaks one is refused whole by Ajv. */
const META: [keys: string[], valid: (value: unknown) => boolean, rule: string][] = [
  [['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'], isCount, 'a non-negative integer'],
  [['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'], isNumber, 'a number'],
  [['multipleOf'], (v) => isDataRef(v) || (isNumber(v) && (v as number) > 0), 'a number above 0'],
  [['enum'], (v) => isDataRef(v) || (Array.isArray(v) && v.length > 0 && distinct(v)), 'a non-empty array of distinct values'],
  [['required'], (v) => isDataRef(v) || isNames(v), 'an array of distinct strings'],
  [['type'], (v) => (typeof v === 'string' ? JSON_TYPES.has(v) : isTypeList(v)), 'a JSON type or a non-empty list of distinct ones'],
  [['pattern'], (v) => isDataRef(v) || (typeof v === 'string' && validPattern(v)), 'a valid regular expression with the u flag'],
  [['format'], (v) => isDataRef(v) || typeof v === 'string', 'a string'],
  [['title', 'description', '$ref', '$comment'], (v) => typeof v === 'string', 'a string'],
  [['uniqueItems', 'readOnly'], (v) => typeof v === 'boolean' || isDataRef(v), 'a boolean'],
  [['additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'], isSchema, 'a schema'],
  [['items'], (v) => isSchema(v) || (Array.isArray(v) && v.every(isSchema)), 'a schema or an array of schemas'],
  [['allOf', 'anyOf', 'oneOf'], (v) => Array.isArray(v) && v.length > 0 && v.every(isSchema), 'a non-empty array of schemas'],
  [['properties', 'definitions'], (v) => isJson(v) && Object.values(v).every(isSchema), 'an object of schemas'],
  [['patternProperties'], (v) => isJson(v) && Object.entries(v).every(([p, s]) => validPattern(p) && isSchema(s)), 'an object of schemas keyed by valid regular expressions'],
  [['dependencies'], (v) => isJson(v) && Object.values(v).every((d) => isSchema(d) || isNames(d)), 'an object of schemas or name lists'],
  [['examples'], Array.isArray, 'an array'],
];

function ownRefusal(schema: Json, root: boolean): string | undefined {
  // Below the root Ajv reads `$schema` as an unknown keyword.
  if (root && typeof schema.$schema === 'string' && !DRAFT_07.test(schema.$schema)) return `$schema '${schema.$schema}' is not draft-07`;
  for (const [keys, valid, rule] of META) {
    const key = keys.find((k) => k in schema && !valid(schema[k]));
    if (key !== undefined) return `'${key}' must be ${rule}`;
  }
  return undefined;
}

/** Why Ajv refuses `schema` (its meta-schema check fails or it does not compile); undefined when it accepts it. */
export function refusalOf(schema: unknown, named = false, root = true): string | undefined {
  if (Array.isArray(schema)) return schema.map((item) => refusalOf(item, false, false)).find((r) => r !== undefined);
  if (!isJson(schema)) return undefined;
  const own = named ? undefined : ownRefusal(schema, root);
  if (own) return own;
  for (const [key, value] of Object.entries(schema)) {
    const skipped = !named && (key.startsWith('x-') || DATA.has(key));
    const found = skipped ? undefined : refusalOf(value, !named && (NAMED.has(key) || key === '$defs' || key === 'definitions'), false);
    if (found) return found;
  }
  return undefined;
}

/** One generated `const`: a manifest schema, or a local definition hoisted out of one. */
export interface NamedSchema {
  key: string;
  /** The `const` name. */
  name: string;
  /** The interface `client.ts` declares for it, which the schema is checked against. */
  typeName?: string;
  schema: unknown;
  /** The manifest schema the node lives in: local `$ref`s resolve against it, and diagnostics name it. */
  owner: string;
  pointer: string;
}

/**
 * The schemas `client.zod.ts` declares, their `$ref` edges and a declaration order. A `const` can only read one
 * declared before it, so references inside a cycle are the ones the emitter must defer.
 */
export class SchemaGraph {
  private readonly entries = new Map<string, NamedSchema>();
  private readonly names = new Set<string>();
  private readonly edges = new Map<string, string[]>();
  private readonly component = new Map<string, number>();
  private sorted: NamedSchema[] = [];
  private readonly refusals = new Map<string, string>();

  constructor(
    private readonly ctx: TypeContext,
    roots: Iterable<string>,
  ) {
    const pending = [...roots];
    for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
      if (this.entries.has(id)) continue;
      const entry = this.add(id);
      if (!entry) continue;
      const targets = isPartial(entry.schema) ? [] : refsIn(entry.schema).flatMap((ref) => this.resolve(ref, entry.owner) ?? []);
      this.edges.set(id, [...new Set(targets)]);
      pending.push(...targets);
    }
    this.order();
    this.refuse();
  }

  /**
   * Why the server does not validate the schema at `key`: Ajv refuses it, or a schema it references. The server then
   * leaves the argument unchecked (or fails the boot), so the schema must accept anything.
   */
  public refused(key: string): string | undefined {
    return this.refusals.get(key);
  }

  /** The same for a schema that is not declared, such as an argument schema printed inline. */
  public refusalOfSchema(schema: unknown, owner: string): string | undefined {
    const own = refusalOf(schema);
    if (own) return own;
    const target = refsIn(schema)
      .map((ref) => this.resolve(ref, owner))
      .find((key) => key !== undefined && this.refusals.has(key));
    return target === undefined ? undefined : this.referenceRefusal(target);
  }

  private referenceRefusal(target: string): string {
    return `it references ${this.entries.get(target)?.owner ?? target}, which Ajv refuses (${this.refusals.get(target)})`;
  }

  private refuse(): void {
    for (const entry of this.entries.values()) {
      const reason = refusalOf(this.ctx.schemaOf(entry.owner));
      if (reason) this.refusals.set(entry.key, reason);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [key, targets] of this.edges) {
        const target = this.refusals.has(key) ? undefined : targets.find((t) => this.refusals.has(t));
        if (target === undefined) continue;
        this.refusals.set(key, this.referenceRefusal(target));
        changed = true;
      }
    }
  }

  /** The key of the schema `ref` points at, from inside `owner`; undefined when it is not in the manifest. */
  public resolve(ref: string, owner: string): string | undefined {
    if (ref === '#') return owner;
    const local = LOCAL.exec(ref);
    if (local) {
      const group = this.ctx.schemaOf(owner)?.[local[1]];
      return isJson(group) && Object.hasOwn(group, local[2]) ? `${owner}#${ref.slice(1)}` : undefined;
    }
    return !ref.startsWith('#') && this.ctx.schemaOf(ref) ? ref : undefined;
  }

  public get(key: string): NamedSchema | undefined {
    return this.entries.get(key);
  }

  /** Dependencies first; inside a cycle, by name. */
  public get declarations(): readonly NamedSchema[] {
    return this.sorted;
  }

  /** Whether `to` is declared in the same cycle as `from`, so `from` cannot read it while it is being built. */
  public cyclic(from: string | undefined, to: string): boolean {
    return from !== undefined && this.component.get(from) !== undefined && this.component.get(from) === this.component.get(to);
  }

  private add(key: string): NamedSchema | undefined {
    const hash = key.indexOf('#');
    if (hash < 0) {
      const schema = this.ctx.schemaOf(key);
      if (!schema) return undefined;
      return this.store({ key, name: this.unique(this.ctx.nameOf(key)), ...(this.ctx.used.has(key) ? { typeName: this.ctx.nameOf(key) } : {}), schema, owner: key, pointer: '' });
    }
    const owner = key.slice(0, hash);
    const [, group, name] = LOCAL.exec(key.slice(hash)) ?? [];
    const schema = (this.ctx.schemaOf(owner)?.[group] as Json)[name];
    return this.store({ key, name: this.unique(`${this.ctx.nameOf(owner)}_${sanitize(name)}`), schema, owner, pointer: key.slice(hash + 1) });
  }

  private store(entry: NamedSchema): NamedSchema {
    this.entries.set(entry.key, entry);
    return entry;
  }

  private unique(base: string): string {
    let name = `${base}Schema`;
    for (let n = 2; this.names.has(name); n++) name = `${base}${n}Schema`;
    this.names.add(name);
    return name;
  }

  // Tarjan's algorithm: a component is complete only after every component it reaches, which is declaration order.
  private order(): void {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const visit = (key: string): void => {
      index.set(key, index.size);
      low.set(key, index.get(key)!);
      stack.push(key);
      for (const to of this.sortedTargets(key)) {
        if (!index.has(to)) {
          visit(to);
          low.set(key, Math.min(low.get(key)!, low.get(to)!));
        } else if (stack.includes(to)) low.set(key, Math.min(low.get(key)!, index.get(to)!));
      }
      if (low.get(key) === index.get(key)) this.close(stack, key);
    };
    for (const key of this.byName([...this.entries.keys()])) if (!index.has(key)) visit(key);
  }

  private close(stack: string[], root: string): void {
    const members: string[] = [];
    for (let key = stack.pop(); key !== undefined; key = key === root ? undefined : stack.pop()) members.push(key);
    const id = this.component.size === 0 ? 0 : Math.max(...this.component.values()) + 1;
    const cycle = members.length > 1 || (this.edges.get(root) ?? []).includes(root);
    for (const key of this.byName(members)) {
      if (cycle) this.component.set(key, id);
      this.sorted.push(this.entries.get(key)!);
    }
  }

  private sortedTargets(key: string): string[] {
    return this.byName((this.edges.get(key) ?? []).filter((to) => this.entries.has(to)));
  }

  private byName(keys: string[]): string[] {
    return [...keys].sort((a, b) => compare(this.entries.get(a)!.name, this.entries.get(b)!.name));
  }
}
