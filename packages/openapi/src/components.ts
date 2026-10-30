export type JsonSchema = Record<string, unknown>;

export interface ComponentRegistry {
  /** Returns `#/components/schemas/<name>` and registers the schema once. */
  ref(id: string): string;
  /**
   * Converts a draft-07 fragment into the 3.1 dialect: manifest `$ref` ids become component refs, `$defs` are hoisted
   * into components, tuples become `prefixItems`; `x-*`, `$id` and `$schema` are dropped.
   * `ownerId` is the manifest schema the fragment was cut from; it resolves the fragment's local `#/$defs/..` refs.
   */
  rewrite(schema: unknown, ownerId?: string): unknown;
  /** Component ref for an object schema; the body itself for unions, arrays and primitives. */
  refOrInline(id: string): unknown;
  schemas(): Record<string, unknown>;
}

// Keys whose children are a name -> schema map: the names are user data, not keywords.
const NAME_MAPS = new Set(['properties', 'patternProperties']);
const DEF_KEYS = ['$defs', 'definitions'] as const;
// Values of these keywords are data, not schemas.
const OPAQUE = new Set(['enum', 'const', 'default', 'examples', 'example']);

export function slugify(id: string): string {
  return id
    .replace(/\.json$/, '')
    .split('/')
    .pop()!
    .replace(/[^A-Za-z0-9_]/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface Scope {
  /** Manifest schema id, for error messages. */
  where: string;
  /** `$defs`/`definitions` key -> hoisted component name. */
  defs: Map<string, string>;
}

export function createComponentRegistry(manifestSchemas: Record<string, unknown>): ComponentRegistry {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const scopes = new Map<string, Scope>();
  const registered = new Map<string, unknown>();

  function claim(preferred: string, fallback: string): string {
    let name = used.has(preferred) ? fallback : preferred;
    for (let n = 2; used.has(name); n++) name = `${fallback}_${n}`;
    used.add(name);
    return name;
  }

  function nameFor(id: string): string {
    const known = names.get(id);
    if (known) return known;
    const name = claim(slugify(id), id.replace(/^spinajs\//, '').replace(/\.json$/, '').replace(/[^A-Za-z0-9_]/g, '_'));
    names.set(id, name);
    return name;
  }

  function defsOf(source: unknown): [string, string, unknown][] {
    if (!isRecord(source)) return [];
    return DEF_KEYS.flatMap((kind) => {
      const defs = source[kind];
      return isRecord(defs) ? Object.entries(defs).map(([key, def]): [string, string, unknown] => [kind, key, def]) : [];
    });
  }

  /** One scope per manifest schema; its local definitions get component names up front so refs between them (and recursion) resolve. */
  function scopeFor(id: string): Scope {
    const known = scopes.get(id);
    if (known) return known;
    const scope: Scope = { where: id, defs: new Map() };
    scopes.set(id, scope);
    const owner = nameFor(id);
    for (const [, key] of defsOf(manifestSchemas[id])) {
      if (!scope.defs.has(key)) scope.defs.set(key, claim(`${owner}_${slugify(key)}`, `${owner}_def_${slugify(key)}`));
    }
    return scope;
  }

  function hoistDefs(id: string): void {
    const scope = scopeFor(id);
    for (const [kind, key, def] of defsOf(manifestSchemas[id])) {
      const name = scope.defs.get(key)!;
      if (registered.has(name)) continue;
      registered.set(name, undefined);
      registered.set(name, rewrite(def, scope, `/${kind}/${key}`));
    }
  }

  function resolveRef(ref: string, scope: Scope, pointer: string): string {
    if (Object.hasOwn(manifestSchemas, ref)) return registry.ref(ref);
    const local = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
    const hoisted = local ? scope.defs.get(decodeURIComponent(local[1])) : undefined;
    if (hoisted) return `#/components/schemas/${hoisted}`;
    throw new Error(`cannot resolve $ref '${ref}' at '${pointer || '/'}' of schema '${scope.where}'`);
  }

  function rewriteTuple(source: Record<string, unknown>, out: Record<string, unknown>, scope: Scope, pointer: string): void {
    out.prefixItems = (source.items as unknown[]).map((item, i) => rewrite(item, scope, `${pointer}/items/${i}`));
    const extra = source.additionalItems;
    if (extra === false) out.items = false;
    else if (isRecord(extra)) out.items = rewrite(extra, scope, `${pointer}/additionalItems`);
  }

  function rewriteDependencies(deps: Record<string, unknown>, out: Record<string, unknown>, scope: Scope, pointer: string): void {
    for (const [key, value] of Object.entries(deps)) {
      const target = Array.isArray(value) ? 'dependentRequired' : 'dependentSchemas';
      const bucket = (out[target] ??= {}) as Record<string, unknown>;
      bucket[key] = Array.isArray(value) ? value : rewrite(value, scope, `${pointer}/dependencies/${key}`);
    }
  }

  function rewriteEntry(key: string, value: unknown, source: Record<string, unknown>, out: Record<string, unknown>, scope: Scope, pointer: string): void {
    const here = `${pointer}/${key}`;
    if (key === '$ref' && typeof value === 'string') out[key] = resolveRef(value, scope, pointer);
    else if (key === '$id' || key === '$schema' || key === 'additionalItems' || key.startsWith('x-') || (DEF_KEYS as readonly string[]).includes(key)) return;
    else if (key === 'items' && Array.isArray(value)) rewriteTuple(source, out, scope, pointer);
    else if (key === 'dependencies' && isRecord(value)) rewriteDependencies(value, out, scope, pointer);
    else if (OPAQUE.has(key)) out[key] = structuredClone(value);
    else if (NAME_MAPS.has(key) && isRecord(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, rewrite(child, scope, `${here}/${name}`)]));
    else out[key] = rewrite(value, scope, here);
  }

  function rewrite(schema: unknown, scope: Scope, pointer: string): unknown {
    if (Array.isArray(schema)) return schema.map((item, i) => rewrite(item, scope, `${pointer}/${i}`));
    if (!isRecord(schema)) return schema;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) rewriteEntry(key, value, schema, out, scope, pointer);
    return out;
  }

  const registry: ComponentRegistry = {
    ref(id) {
      const name = nameFor(id);
      if (!registered.has(name)) {
        if (!Object.hasOwn(manifestSchemas, id)) throw new Error(`manifest has no schema '${id}'`);
        registered.set(name, undefined); // reserve first so a recursive schema terminates
        registered.set(name, rewrite(manifestSchemas[id], scopeFor(id), ''));
        hoistDefs(id);
      }
      return `#/components/schemas/${name}`;
    },
    rewrite(schema, ownerId) {
      if (ownerId && Object.hasOwn(manifestSchemas, ownerId)) hoistDefs(ownerId);
      const scope = ownerId && Object.hasOwn(manifestSchemas, ownerId) ? scopeFor(ownerId) : { where: ownerId ?? 'inline schema', defs: new Map<string, string>() };
      return rewrite(schema, scope, '');
    },
    refOrInline(id) {
      const body = Object.hasOwn(manifestSchemas, id) ? manifestSchemas[id] : undefined;
      if (body === undefined || (isRecord(body) && body.type === 'object')) return { $ref: registry.ref(id) };
      hoistDefs(id);
      return rewrite(body, scopeFor(id), '');
    },
    schemas() {
      return Object.fromEntries([...registered.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  };
  return registry;
}
