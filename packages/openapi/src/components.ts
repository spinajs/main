export type JsonSchema = Record<string, unknown>;

export interface ComponentRegistry {
  /** Returns `#/components/schemas/<name>` and registers the schema once. */
  ref(id: string): string;
  /** Rewrites nested `$ref: '<id>'` (manifest ids) into component refs; returns a deep copy without `x-*`, `$id` and `$schema`. */
  rewrite(schema: unknown): unknown;
  /** Component ref for an object schema; the body itself for unions, arrays and primitives. */
  refOrInline(id: string): unknown;
  schemas(): Record<string, unknown>;
}

// Keys whose children are a name -> schema map: the names are user data, not keywords.
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

export function slugify(id: string): string {
  return id.replace(/\.json$/, '').split('/').pop()!.replace(/[^A-Za-z0-9_]/g, '_');
}

function isObjectSchema(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && (schema as JsonSchema).type === 'object';
}

export function createComponentRegistry(manifestSchemas: Record<string, unknown>): ComponentRegistry {
  const names = new Map<string, string>();
  const used = new Map<string, string>();
  const registered = new Map<string, unknown>();

  function nameFor(id: string): string {
    const known = names.get(id);
    if (known) return known;
    const short = slugify(id);
    // The first type keeps the short name; a later one with the same short name gets its package path folded in.
    const name = used.has(short) ? id.replace(/^spinajs\//, '').replace(/\.json$/, '').replace(/[^A-Za-z0-9_]/g, '_') : short;
    names.set(id, name);
    used.set(name, id);
    return name;
  }

  function rewrite(schema: unknown, nameMap: boolean): unknown {
    if (Array.isArray(schema)) return schema.map((item) => rewrite(item, false));
    if (!schema || typeof schema !== 'object') return schema;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (nameMap) out[key] = rewrite(value, false);
      else if (key === '$ref' && typeof value === 'string' && value in manifestSchemas) out[key] = registry.ref(value);
      else if (key === '$id' || key === '$schema' || key === '$defs' || key.startsWith('x-')) continue;
      else out[key] = rewrite(value, NAME_MAPS.has(key));
    }
    return out;
  }

  const registry: ComponentRegistry = {
    ref(id) {
      const name = nameFor(id);
      if (!registered.has(name)) {
        const source = manifestSchemas[id];
        if (!source) throw new Error(`manifest has no schema '${id}'`);
        registered.set(name, undefined); // reserve first so a recursive schema terminates
        registered.set(name, rewrite(source, false));
      }
      return `#/components/schemas/${name}`;
    },
    rewrite: (schema) => rewrite(schema, false),
    refOrInline(id) {
      const body = manifestSchemas[id];
      return body === undefined || isObjectSchema(body) ? { $ref: registry.ref(id) } : rewrite(body, false);
    },
    schemas() {
      return Object.fromEntries([...registered.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  };
  return registry;
}
