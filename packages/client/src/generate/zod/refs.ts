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
const NUMERIC = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties'];
// Values that are data, not schemas.
const DATA = new Set(['const', 'enum', 'default', 'examples']);

function validPattern(pattern: string): boolean {
  try {
    return new RegExp(pattern, 'u') instanceof RegExp;
  } catch {
    return false;
  }
}

function ownRefusal(schema: Json): string | undefined {
  if (typeof schema.$schema === 'string' && !DRAFT_07.test(schema.$schema)) return `$schema '${schema.$schema}' is not draft-07`;
  const types: unknown[] = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  const type = types.find((t) => typeof t !== 'string' || !JSON_TYPES.has(t));
  if (type !== undefined) return `type ${JSON.stringify(type)} is not a JSON Schema type`;
  if (schema.pattern !== undefined && (typeof schema.pattern !== 'string' || !validPattern(schema.pattern))) return 'pattern is not a valid regular expression with the u flag';
  // `{ $data }` is FG-5's to map; until then the keyword is dropped with ZOD003.
  const limit = NUMERIC.find((k) => k in schema && !(typeof schema[k] === 'number' && Number.isFinite(schema[k])) && !(isJson(schema[k]) && '$data' in schema[k]));
  return limit === undefined ? undefined : `'${limit}' is not a number`;
}

/** Why Ajv refuses `schema` (its meta-schema check fails or it does not compile); undefined when it accepts it. */
export function refusalOf(schema: unknown, named = false): string | undefined {
  if (Array.isArray(schema)) return schema.map((item) => refusalOf(item)).find((r) => r !== undefined);
  if (!isJson(schema)) return undefined;
  const own = named ? undefined : ownRefusal(schema);
  if (own) return own;
  for (const [key, value] of Object.entries(schema)) {
    const found = named ? refusalOf(value) : key.startsWith('x-') || DATA.has(key) ? undefined : refusalOf(value, NAMED.has(key) || key === '$defs' || key === 'definitions');
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
    if (local) return isJson(this.ctx.schemaOf(owner)?.[local[1]]) && Object.hasOwn(this.ctx.schemaOf(owner)?.[local[1]] as Json, local[2]) ? `${owner}#${ref.slice(1)}` : undefined;
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
