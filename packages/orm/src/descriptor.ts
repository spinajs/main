import { isConstructor, collapseInheritedDescriptor } from '@spinajs/di';
import { IMigrationDescriptor, IModelDescriptor } from "./interfaces.js";
import { MIGRATION_DESCRIPTION_SYMBOL, MODEL_DESCTRIPTION_SYMBOL } from "./symbols.js";

export function createDefaultModelDescriptor(): IModelDescriptor {
  return {
    Driver: null,
    Converters: new Map(),
    Columns: [],
    Connection: null,
    PrimaryKey: [],
    PrimaryKeyGeneration: new Map(),
    SoftDelete: {
      DeletedAt: '',
    },
    Archived: {
      ArchivedAt: '',
    },
    TableName: '',
    Timestamps: {
      CreatedAt: '',
      UpdatedAt: '',
    },
    Name: "",
    Relations: new Map(),
    JunctionModelProperties: [],
    DiscriminationMap: {
      Field: '',
      Models: null,
    },
    Schema: {},
    ResponseSchema: {},
    Hidden: [],
  };
}

export function extractModelDescriptorInherited(targetOrForward: any): IModelDescriptor | null {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  // Only the NEAREST own descriptor is collapsed onto a fresh default, and every stored
  // descriptor is already collapsed, so array fields ( Columns, PrimaryKey ) gain no duplicate
  // per inheritance level - the de-duplication the name-keyed reader needed is now structural.
  return {
    ...collapseInheritedDescriptor(target, MODEL_DESCTRIPTION_SYMBOL, createDefaultModelDescriptor),
    // Name is always this class's own, never inherited - the merger would
    // otherwise keep the parent's non-empty name over the child's default ''
    Name: target.name,
  };
}

export function extractModelDescriptor(targetOrForward: any): IModelDescriptor | null {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  // master's own-metadata-per-class read. MUST stay paired with the write side in
  // decorators.ts `_getMetadataFrom`, which replaced the old name-keyed container —
  // that container collapsed two classes sharing a name into one slot (A9 in the
  // ORM analysis). Reading name-keyed here against an own-metadata write returns null
  // for every model.
  return (Reflect.getOwnMetadata(MODEL_DESCTRIPTION_SYMBOL, target) as IModelDescriptor) ?? null;
}

/**
 * The one `MIGRATION_DESCRIPTION_SYMBOL` cast, shared by every reader instead of repeated at each
 * call site (`orm.ts`, `migration-sources.ts`, `migration-runner.ts` each used to carry their own
 * copy). Unlike a model's descriptor - written with `Reflect.getOwnMetadata`, own-per-class by
 * construction - `@Migration()` writes this one as a plain property, which the prototype chain
 * resolves through automatically: reading it off a subclass that carries no `@Migration()` of its
 * own returns its nearest decorated ANCESTOR's descriptor.
 *
 * That is exactly what `MigrationRunner.plan()` wants for `Connection` - a subclass is still the
 * same migration on the same connection whether or not it re-declares `@Migration()` - so this
 * chain-walking read is the correct one there, and for `DiRegistryMigrationSource` ( whose entries
 * are, by construction, only ever classes `@Migration()` was applied to directly, so "chain" and
 * "own" agree ).
 */
export function extractMigrationDescriptor(target: unknown): IMigrationDescriptor | undefined {
  return (target as Record<symbol, IMigrationDescriptor | undefined> | null | undefined)?.[MIGRATION_DESCRIPTION_SYMBOL];
}

/**
 * The same descriptor, but OWN ONLY - `undefined` for a subclass that carries no `@Migration()` of
 * its own, even though `extractMigrationDescriptor` above would resolve one through the prototype
 * chain from its nearest decorated ancestor.
 *
 * `Orm.discoverMigrations()` needs exactly this for `Env`: a subclass does not inherit WHERE its
 * parent runs, only what it does. Reading through the chain here would make an undecorated
 * subclass of an `{ Env: 'local' }` migration silently inherit 'local' and vanish under every other
 * environment - and, the other direction, throw a spurious "declares environment X via @Migration"
 * for a subclass whose file suffix merely disagrees with an ancestor's declaration it never made
 * itself.
 */
export function extractOwnMigrationDescriptor(target: unknown): IMigrationDescriptor | undefined {
  if (!target || !Object.prototype.hasOwnProperty.call(target, MIGRATION_DESCRIPTION_SYMBOL)) {
    return undefined;
  }

  return (target as Record<symbol, IMigrationDescriptor | undefined>)[MIGRATION_DESCRIPTION_SYMBOL];
}
