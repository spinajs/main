import { AuthzConfigError, UnknownPermission } from '../contracts/errors.js';
import { PermissionRegistry, compilePermissionGlob, isPermission, parsePermission } from '../contracts/permission.js';
import type { Permission, PermissionDef } from '../contracts/permission.js';
import type { ResourceType } from '../contracts/principal.js';

export type PermissionInput = Omit<PermissionDef, 'source' | 'resource' | 'action' | 'types'> & { types?: readonly ResourceType[]; resource?: string; action?: string };

interface Entry {
  readonly name: Permission;
  readonly resource: string;
  readonly action: string;
  // Explicit types only; empty means the default [resource].
  readonly types: ResourceType[];
  readonly implies: Permission[];
  fields?: boolean;
  list?: boolean;
  description?: string;
  readonly sources: string[];
  def: PermissionDef;
}

type Normalized = Omit<Entry, 'sources' | 'def'>;

export class PermissionRegistryImpl extends PermissionRegistry {
  private readonly entries = new Map<Permission, Entry>();
  private isFrozen = false;
  private allCache: readonly PermissionDef[] | undefined;
  private reverse: Map<Permission, Permission[]> | undefined;

  get frozen(): boolean {
    return this.isFrozen;
  }

  register(defs: readonly PermissionInput[], source: string): void {
    if (this.isFrozen) {
      throw new AuthzConfigError(`Permission registry is frozen: cannot register from source ${quote(source)}`);
    }
    if (typeof source !== 'string' || source === '') {
      throw new AuthzConfigError(`Permission source must be a non-empty string, got ${quote(source)}`);
    }
    if (!Array.isArray(defs)) {
      throw new AuthzConfigError(`Permission defs from source ${quote(source)} must be an array`);
    }

    // Validate the whole batch first so a bad def registers nothing.
    let normalized: Normalized[];
    try {
      normalized = defs.map((def) => normalize(def, source));
    } catch (err) {
      if (err instanceof AuthzConfigError) {
        throw err;
      }
      throw new AuthzConfigError(`Permission defs from source ${quote(source)} could not be read`, { cause: err });
    }

    for (const n of normalized) {
      const existing = this.entries.get(n.name);
      if (!existing) {
        const base = { ...n, sources: [source] };
        this.entries.set(n.name, { ...base, def: toDef(base) });
        continue;
      }
      pushUnique(existing.types, n.types);
      pushUnique(existing.implies, n.implies);
      if (n.fields !== undefined) {
        existing.fields = existing.fields === true || n.fields;
      }
      if (n.list !== undefined) {
        existing.list = existing.list === true || n.list;
      }
      if (!existing.description && n.description) {
        existing.description = n.description;
      }
      pushUnique(existing.sources, [source]);
      existing.def = toDef(existing);
    }

    this.allCache = undefined;
    this.reverse = undefined;
  }

  freeze(): void {
    if (this.isFrozen) {
      return;
    }
    for (const entry of this.entries.values()) {
      for (const implied of entry.implies) {
        if (!this.entries.has(implied)) {
          throw new UnknownPermission(`Permission ${quote(entry.name)} implies ${quote(implied)}, which is not registered`);
        }
      }
    }
    this.isFrozen = true;
  }

  get(name: Permission): PermissionDef | undefined {
    return typeof name === 'string' ? this.entries.get(name)?.def : undefined;
  }

  require(name: Permission): PermissionDef {
    parsePermission(name);
    const def = this.entries.get(name)?.def;
    if (!def) {
      throw new UnknownPermission(`Unknown permission ${quote(name)}`);
    }
    return def;
  }

  match(glob: string): readonly PermissionDef[] {
    const matches = compilePermissionGlob(glob);
    return Object.freeze(this.all().filter((def) => matches(def.name)));
  }

  all(): readonly PermissionDef[] {
    if (!this.allCache) {
      this.allCache = Object.freeze([...this.entries.values()].map((e) => e.def));
    }
    return this.allCache;
  }

  impliedBy(name: Permission): readonly Permission[] {
    parsePermission(name);
    const reverse = this.reverseIndex();
    const seen = new Set<Permission>([name]);
    const queue: Permission[] = [name];
    while (queue.length > 0) {
      for (const implier of reverse.get(queue.shift()!) ?? []) {
        if (!seen.has(implier)) {
          seen.add(implier);
          queue.push(implier);
        }
      }
    }
    seen.delete(name);
    return Object.freeze([...seen].sort(compareCodePoints));
  }

  types(): readonly ResourceType[] {
    const all = new Set<ResourceType>();
    for (const entry of this.entries.values()) {
      for (const type of entry.def.types) {
        all.add(type);
      }
    }
    return Object.freeze([...all].sort(compareCodePoints));
  }

  private reverseIndex(): Map<Permission, Permission[]> {
    if (!this.reverse) {
      const reverse = new Map<Permission, Permission[]>();
      for (const entry of this.entries.values()) {
        for (const implied of entry.implies) {
          const list = reverse.get(implied);
          if (list) {
            list.push(entry.name);
          } else {
            reverse.set(implied, [entry.name]);
          }
        }
      }
      this.reverse = reverse;
    }
    return this.reverse;
  }
}

const normalize = (def: PermissionInput, source: string): Normalized => {
  if (typeof def !== 'object' || def === null) {
    throw new AuthzConfigError(`Permission def from source ${quote(source)} must be an object, got ${quote(def)}`);
  }
  const name = def.name;
  if (!isPermission(name)) {
    throw new AuthzConfigError(`Invalid permission name ${quote(name)} from source ${quote(source)}: expected <resource>:<action>, each [A-Za-z][A-Za-z0-9_.-]*`);
  }
  const { resource, action } = parsePermission(name);
  if (def.resource !== undefined && def.resource !== resource) {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: resource ${quote(def.resource)} does not match the name (${quote(resource)})`);
  }
  if (def.action !== undefined && def.action !== action) {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: action ${quote(def.action)} does not match the name (${quote(action)})`);
  }

  const types: ResourceType[] = [];
  if (def.types !== undefined) {
    if (!Array.isArray(def.types) || def.types.length === 0) {
      throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: types must be a non-empty array of non-empty strings`);
    }
    for (const type of def.types as readonly unknown[]) {
      if (typeof type !== 'string' || type === '') {
        throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: invalid type ${quote(type)}`);
      }
      pushUnique(types, [type]);
    }
  }

  const implies: Permission[] = [];
  if (def.implies !== undefined) {
    if (!Array.isArray(def.implies)) {
      throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: implies must be an array`);
    }
    for (const implied of def.implies as readonly unknown[]) {
      if (!isPermission(implied)) {
        throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: invalid implies entry ${quote(implied)}`);
      }
      pushUnique(implies, [implied]);
    }
  }

  if (def.fields !== undefined && typeof def.fields !== 'boolean') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: fields must be a boolean`);
  }
  if (def.list !== undefined && typeof def.list !== 'boolean') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: list must be a boolean`);
  }
  if (def.description !== undefined && typeof def.description !== 'string') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: description must be a string`);
  }

  return { name, resource, action, types, implies, fields: def.fields, list: def.list, description: def.description };
};

const toDef = (e: Omit<Entry, 'def'>): PermissionDef => {
  const def: { -readonly [K in keyof PermissionDef]: PermissionDef[K] } = { name: e.name, resource: e.resource, action: e.action, types: Object.freeze(e.types.length > 0 ? [...e.types] : [e.resource]), source: e.sources.join(',') };
  if (e.implies.length > 0) {
    def.implies = Object.freeze([...e.implies]);
  }
  if (e.fields !== undefined) {
    def.fields = e.fields;
  }
  if (e.list !== undefined) {
    def.list = e.list;
  }
  if (e.description) {
    def.description = e.description;
  }
  return Object.freeze(def);
};

const pushUnique = <T>(target: T[], values: readonly T[]): void => {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
};

const compareCodePoints = (a: string, b: string): number => {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done || cb.done) {
      return ca.done ? (cb.done ? 0 : -1) : 1;
    }
    const diff = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
};

const quote = (value: unknown): string => {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
