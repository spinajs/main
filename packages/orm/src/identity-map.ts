/* eslint-disable prettier/prettier */
import { Constructor } from '@spinajs/di';
import { extractModelDescriptor } from './descriptor.js';
import { IIdentityMap } from './interfaces.js';
import type { ModelBase } from './model.js';

/**
 * Separator between the parts of a composite key. Any character does: every part is
 * length-prefixed, and it is the length prefix — not the separator — that makes two
 * different tuples impossible to confuse.
 */
const KEY_SEPARATOR = '|';

/**
 * Renders a primary-key value as a Map key.
 *
 * Type-tagged so `1` and `'1'` never collide — a string key column and an integer key column
 * on two different models could otherwise alias each other through a shared cache. Returns
 * `null` for an absent key: a model with no primary key cannot be identified and is never
 * registered.
 *
 * A composite key arrives as a tuple ( that is what `ModelBase.PrimaryKeyValue` returns for a
 * multi-column key ). Its parts are rendered individually and length-prefixed, because
 * `String([1, 2])` and `String(['1,2'])` are both `"1,2"`. A tuple with any part missing has
 * no identity at all, so it renders as `null` — the same answer as a missing scalar key.
 *
 * A one-element tuple renders exactly like the bare scalar: the ORM reads a single-column key
 * as a scalar everywhere, and both spellings must reach the same entry.
 *
 * @param pk - primary key value: a scalar, or a tuple in key order
 */
export function identityKey(pk: unknown): string | null {
  if (pk === null || pk === undefined) {
    return null;
  }

  if (Buffer.isBuffer(pk)) {
    return `b:${pk.toString('hex')}`;
  }

  if (Array.isArray(pk)) {
    if (pk.length === 1) {
      return identityKey(pk[0]);
    }

    const parts: string[] = [];
    for (const part of pk) {
      const rendered = identityKey(part);
      if (rendered === null) {
        return null;
      }
      parts.push(`${rendered.length}:${rendered}`);
    }

    return parts.join(KEY_SEPARATOR);
  }

  return `${typeof pk}:${String(pk)}`;
}

/**
 * Maps `(table, primary key) -> instance` for the duration of one `save()` graph walk, or of
 * one transaction when several saves run inside it ( overview decision D7 ).
 *
 * Its only job is to guarantee that a row reached through two relation paths produces one
 * subject rather than two conflicting ones. It is **not** a cache: nothing outside a
 * `save()` consults it, it is discarded when the transaction ends, and queries behave
 * exactly as they did before.
 *
 * **Keyed by table name, not by constructor.** A row's identity is the table it lives in plus
 * its key — that is the definition `SubjectBuilder.buildOrphans` has always used, for the
 * reason it records there: a `@DiscriminationMap` produces several constructors for one
 * table, and a subclass instance is still the same row. Keying here by constructor made the
 * two disagree, so the same row reached once as its base class and once as its discriminated
 * subclass produced two entries and two conflicting subjects for one row.
 *
 * Table names are unique within the map's scope because `UnitOfWork.save()` refuses to span
 * connections, so the A9 concerns that ruled out CLASS NAME keys — minification, and two
 * connections declaring the same class name — do not apply to table names here. A table name
 * is data from the schema, not a symbol the bundler may rewrite.
 */
export class IdentityMap implements IIdentityMap {
  private _entries = new Map<unknown, Map<string, ModelBase>>();

  private _size = 0;

  public get Size(): number {
    return this._size;
  }

  public get(model: Constructor<ModelBase>, pk: unknown): ModelBase | undefined {
    const key = identityKey(pk);
    if (key === null) {
      return undefined;
    }

    return this._entries.get(scopeOf(model))?.get(key);
  }

  public has(model: Constructor<ModelBase>, pk: unknown): boolean {
    return this.get(model, pk) !== undefined;
  }

  /**
   * Registers `model` and returns the canonical instance for its identity — the one already
   * registered if there is one, otherwise `model` itself. A model with no primary key is
   * returned unchanged and not registered: it has no identity yet.
   *
   * @param model - model to canonicalize
   */
  public add(model: ModelBase): ModelBase {
    const key = identityKey(model.PrimaryKeyValue);
    if (key === null) {
      return model;
    }

    const scope = scopeOf(model.constructor as Constructor<ModelBase>);
    let byKey = this._entries.get(scope);

    if (!byKey) {
      byKey = new Map<string, ModelBase>();
      this._entries.set(scope, byKey);
    }

    const existing = byKey.get(key);
    if (existing) {
      return existing;
    }

    byKey.set(key, model);
    this._size += 1;

    return model;
  }

  public clear(): void {
    this._entries.clear();
    this._size = 0;
  }
}

/**
 * The bucket a model class's rows live in: its table when it has a descriptor, otherwise the
 * constructor itself.
 *
 * The table string and the constructor object can never collide as Map keys, so the fallback
 * is safe. It exists for classes the ORM was handed without a `@Model` decorator — they have
 * no table to unify on, and each constructor keeping its own bucket is the old behaviour.
 */
function scopeOf(model: Constructor<ModelBase>): unknown {
  return extractModelDescriptor(model)?.TableName ?? model;
}
