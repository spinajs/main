import { AuthzConfigError, PermissionRegistry, UnknownPermission, compilePermissionGlob, parsePermission } from '@spinajs/authz';
import type { Permission, PermissionDef } from '@spinajs/authz';

/** A name, or the parts of a def to keep; the rest is parsed or defaulted (types = [resource], source 'fake'). */
export type FakePermissionInput = Permission | (Partial<Omit<PermissionDef, 'name'>> & { readonly name: Permission });

export function toPermissionDef(input: FakePermissionInput, source = 'fake'): PermissionDef {
  const partial = typeof input === 'string' ? { name: input } : input;
  const { resource, action } = parsePermission(partial.name);
  const def: Record<string, unknown> = { resource, action, types: [resource], source };
  for (const [k, v] of Object.entries(partial)) if (v !== undefined) def[k] = v;
  if (def.types) def.types = Object.freeze([...(def.types as string[])]);
  if (def.implies) def.implies = Object.freeze([...(def.implies as string[])]);
  return Object.freeze({ name: partial.name, ...def }) as unknown as PermissionDef;
}

export class FakePermissionRegistry extends PermissionRegistry {
  private readonly defs = new Map<Permission, PermissionDef>();

  constructor(defs: readonly FakePermissionInput[] = []) {
    super();
    this.register(...defs);
  }

  register(...defs: readonly FakePermissionInput[]): this {
    for (const input of defs) {
      const def = toPermissionDef(input);
      if (this.defs.has(def.name)) throw new AuthzConfigError(`FakePermissionRegistry: ${def.name} registered twice`);
      this.defs.set(def.name, def);
    }
    return this;
  }

  get(name: Permission): PermissionDef | undefined {
    return this.defs.get(name);
  }

  require(name: Permission): PermissionDef {
    const def = this.defs.get(name);
    if (!def) throw new UnknownPermission(`Unknown permission ${JSON.stringify(name)}`);
    return def;
  }

  match(glob: string): readonly PermissionDef[] {
    const matches = compilePermissionGlob(glob);
    return this.all().filter((d) => matches(d.name));
  }

  /** Every permission that implies `name`, directly or transitively, in registration order; never `name` itself. */
  impliedBy(name: Permission): readonly Permission[] {
    const found = new Set<Permission>([name]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of this.defs.values()) {
        if (!found.has(d.name) && d.implies?.some((p) => found.has(p))) {
          found.add(d.name);
          grew = true;
        }
      }
    }
    return this.all()
      .map((d) => d.name)
      .filter((n) => n !== name && found.has(n));
  }

  all(): readonly PermissionDef[] {
    return [...this.defs.values()];
  }
}
