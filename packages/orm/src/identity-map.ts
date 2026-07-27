/* eslint-disable prettier/prettier */
import { Constructor } from '@spinajs/di';
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
 * Maps `(model constructor, primary key) -> instance` for the duration of one `save()` graph
 * walk, or of one transaction when several saves run inside it ( overview decision D7 ).
 *
 * Its only job is to guarantee that a row reached through two relation paths produces one
 * subject rather than two conflicting ones. It is **not** a cache: nothing outside a
 * `save()` consults it, it is discarded when the transaction ends, and queries behave
 * exactly as they did before.
 *
 * Keyed by constructor identity rather than class name — name-based lookup breaks under
 * minification and when two connections declare models with the same class name ( A9 ).
 */
export class IdentityMap implements IIdentityMap {
  private _entries = new Map<Constructor<ModelBase>, Map<string, ModelBase>>();

  private _size = 0;

  public get Size(): number {
    return this._size;
  }

  public get(model: Constructor<ModelBase>, pk: unknown): ModelBase | undefined {
    const key = identityKey(pk);
    if (key === null) {
      return undefined;
    }

    return this._entries.get(model)?.get(key);
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

    const ctor = model.constructor as Constructor<ModelBase>;
    let byKey = this._entries.get(ctor);

    if (!byKey) {
      byKey = new Map<string, ModelBase>();
      this._entries.set(ctor, byKey);
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
