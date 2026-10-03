import type { AuthzTx } from '../../contracts/admin.js';
import { AuthzAdminFailure } from '../../contracts/admin.js';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { PrincipalRef, ResourceRef } from '../../contracts/principal.js';
import { resourceKey } from '../../contracts/resource.js';
import { memoryTx } from '../backend.js';
import type { MemoryTx } from '../backend.js';
import { WritableScopeAttributeStore } from '../ports.js';
import type { ScopeAttributeLeaf } from '../ports.js';
import { flattenAttributes, underPath, unflattenAttributes } from './flatten.js';

export interface MemoryScopeAttributeStoreOptions {
  /** Stored values to start with, as nested objects. */
  readonly values?: readonly { readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>> }[];
}

const keyOf = (ref: ResourceRef): string => {
  if (ref === null || typeof ref !== 'object' || typeof ref.type !== 'string') throw new AuthzConfigError(`a scope attribute store needs a resource ref, got ${JSON.stringify(ref)}`);
  return resourceKey(ref);
};

/**
 * Scope attributes in memory, for tests and apps without a database. Not registered by default: register
 * one instance under both ScopeAttributeStore and WritableScopeAttributeStore. Writes need a transaction
 * of MemoryAuthzAdminBackend.
 */
export class MemoryScopeAttributeStore extends WritableScopeAttributeStore {
  private readonly nodes = new Map<string, Map<string, ScopeAttributeLeaf>>();
  private counter = 0;

  constructor(opts: MemoryScopeAttributeStoreOptions = {}) {
    super();
    for (const [i, v] of (opts.values ?? []).entries()) {
      let rows: Record<string, ScopeAttributeLeaf>;
      try {
        rows = flattenAttributes(v?.attributes).set;
      } catch (e) {
        if (e instanceof AuthzAdminFailure) throw new AuthzConfigError(`MemoryScopeAttributeStore: values[${i}]: ${e.message}`, { cause: e });
        throw e;
      }
      const key = keyOf(v.scope);
      this.nodes.set(key, new Map([...(this.nodes.get(key) ?? []), ...Object.entries(rows)]));
    }
  }

  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return unflattenAttributes(await this.rows(ref));
  }

  async version(): Promise<string> {
    return String(this.counter);
  }

  async rows(ref: ResourceRef): Promise<Readonly<Record<string, ScopeAttributeLeaf>>> {
    return Object.fromEntries(this.node(ref) ?? []);
  }

  async write(ref: ResourceRef, change: { readonly set: Readonly<Record<string, ScopeAttributeLeaf>>; readonly remove: readonly string[] }, _actor: PrincipalRef, tx: AuthzTx): Promise<number> {
    const undo = memoryTx(tx);
    const set = Object.entries(change?.set ?? {});
    const remove = [...(change?.remove ?? [])];
    for (const [path, v] of set) if (typeof path !== 'string' || path === '' || !(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) throw new AuthzConfigError(`MemoryScopeAttributeStore.write: cannot store ${JSON.stringify(v)} at ${JSON.stringify(path)}`);
    if (!remove.every((p) => typeof p === 'string' && p !== '')) throw new AuthzConfigError('MemoryScopeAttributeStore.write: remove must list paths');

    const key = keyOf(ref);
    this.remember(undo, key);
    let node = this.nodes.get(key);
    if (!node) this.nodes.set(key, (node = new Map()));

    let removed = 0;
    for (const path of [...node.keys()]) {
      // A set path also drops the rows above and below it, so the node always forms one object.
      if (remove.some((p) => underPath(path, p)) || set.some(([p]) => p !== path && (underPath(path, p) || underPath(p, path)))) {
        node.delete(path);
        removed++;
      }
    }
    for (const [path, v] of set) node.set(path, v);
    return removed + set.length;
  }

  async forget(ref: ResourceRef, tx: AuthzTx): Promise<number> {
    const undo = memoryTx(tx);
    const key = keyOf(ref);
    this.remember(undo, key);
    const count = this.nodes.get(key)?.size ?? 0;
    this.nodes.delete(key);
    return count;
  }

  /**
   * Undoes the change to one node. The version moves on again instead of going back: a reader may have seen
   * the rolled back rows under the bumped version, so no version is ever reused.
   */
  private remember(undo: MemoryTx, key: string): void {
    const node = this.nodes.get(key);
    const before = node ? new Map(node) : undefined;
    undo.onRollback(() => {
      this.counter++;
      if (before) this.nodes.set(key, before);
      else this.nodes.delete(key);
    });
    this.counter++;
  }

  private node(ref: ResourceRef): Map<string, ScopeAttributeLeaf> | undefined {
    return this.nodes.get(keyOf(ref));
  }
}
