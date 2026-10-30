import type { Manifest, TypeRef } from '@spinajs/manifest';

type Schema = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PRIMITIVES: Record<string, string> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', null: 'null' };

export function lastSegment(id: string): string {
  return id.split('/').pop() ?? id;
}

function sanitize(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return 'unknown';
}

export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : literal(name);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Maps manifest schemas to TypeScript type expressions and records which named schemas the output references. */
export class TypeContext {
  public readonly used = new Set<string>();
  private readonly names = new Map<string, string>();

  constructor(public readonly manifest: Manifest) {
    const bySegment = new Map<string, string[]>();
    for (const id of Object.keys(manifest.schemas)) {
      const segment = sanitize(lastSegment(id));
      bySegment.set(segment, [...(bySegment.get(segment) ?? []), id]);
    }
    for (const [segment, ids] of bySegment) {
      for (const id of ids) this.names.set(id, ids.length === 1 ? segment : sanitize(id.replace(/^spinajs\//, '')));
    }
  }

  public nameOf(id: string): string {
    return this.names.get(id) ?? sanitize(lastSegment(id));
  }

  public schemaOf(id: string): Schema | undefined {
    const schema = this.manifest.schemas[id];
    return isSchema(schema) ? schema : undefined;
  }

  public reference(id: string): string {
    if (!this.schemaOf(id)) return 'unknown';
    this.used.add(id);
    return this.nameOf(id);
  }

  public typeOf(ref: TypeRef): string {
    const schema = ref.schema ? this.schemaOf(ref.schema) : undefined;
    if (ref.schema && schema) return lastSegment(ref.schema) === ref.text ? this.reference(ref.schema) : this.expression(schema);
    if (ref.text === 'void' || ref.text === 'undefined') return 'void';
    return ['string', 'number', 'boolean'].includes(ref.text) ? ref.text : 'unknown';
  }

  private properties(ref: TypeRef): Schema {
    let schema = ref.schema ? this.schemaOf(ref.schema) : undefined;
    while (schema && typeof schema.$ref === 'string') schema = this.schemaOf(schema.$ref);
    return isSchema(schema?.properties) ? schema.properties : {};
  }

  /** Property names of an object schema, following named $ref aliases. */
  public propertyNames(ref: TypeRef): string[] {
    return Object.keys(this.properties(ref));
  }

  public propertyType(ref: TypeRef, name: string): string | undefined {
    const properties = this.properties(ref);
    return name in properties ? this.expression(properties[name]) : undefined;
  }

  public expression(schema: unknown): string {
    if (!isSchema(schema)) return 'unknown';
    if (typeof schema.$ref === 'string') return this.reference(schema.$ref);
    if ('const' in schema) return literal(schema.const);
    if (Array.isArray(schema.enum)) return unique(list(schema.enum).map(literal)).join(' | ') || 'never';
    const combined = this.combine(schema);
    if (combined) return combined;
    if (Array.isArray(schema.type)) return unique(list(schema.type).map((t) => this.expression({ ...schema, type: t }))).join(' | ');
    return this.byType(schema);
  }

  private combine(schema: Schema): string | undefined {
    for (const [key, glue] of [['anyOf', ' | '], ['oneOf', ' | '], ['allOf', ' & ']] as const) {
      const members = list(schema[key]);
      if (members.length > 0) return unique(members.map((m) => this.expression(m))).join(glue);
    }
    return undefined;
  }

  private byType(schema: Schema): string {
    const type = typeof schema.type === 'string' ? schema.type : isSchema(schema.properties) ? 'object' : undefined;
    if (type && type in PRIMITIVES) return PRIMITIVES[type];
    if (type === 'array') return this.arrayType(schema);
    if (type === 'object') return this.objectType(schema);
    return 'unknown';
  }

  private arrayType(schema: Schema): string {
    const tuple = list(schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined));
    if (tuple.length > 0) return `[${tuple.map((m) => this.expression(m)).join(', ')}]`;
    if (!isSchema(schema.items)) return 'unknown[]';
    const item = this.expression(schema.items);
    return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
  }

  private objectType(schema: Schema): string {
    const required = new Set(list(schema.required));
    const members = isSchema(schema.properties)
      ? Object.entries(schema.properties).map(([name, value]) => `${propertyKey(name)}${required.has(name) ? '' : '?'}: ${this.expression(value)}`)
      : [];
    if (isSchema(schema.additionalProperties)) members.push(`[key: string]: ${this.expression(schema.additionalProperties)}`);
    if (members.length > 0) return `{ ${members.join('; ')} }`;
    return schema.additionalProperties === false ? 'Record<string, never>' : 'Record<string, unknown>';
  }
}
