import { nestExpiry } from '../support/misc.js';
import type { Nested } from '../types.js';

/** A ctx.cache value and the nested record of the call tree that stored it: what the value may rest on. */
export class MemoEntry {
  constructor(
    readonly value: unknown,
    readonly bound: Nested,
  ) {}
}

/** `into` now rests on everything `from` rests on. */
export function restOn(into: Nested, from: Nested): void {
  if (from === into) return;
  for (const t of from.tags) into.tags.add(t);
  into.untagged ||= from.untagged;
  into.uncacheable ||= from.uncacheable;
  into.faulted ||= from.faulted;
  nestExpiry(into, from.until);
  const memos = (into.memos ??= new Set());
  memos.add(from);
  if (from.memos) for (const m of from.memos) if (m !== into) memos.add(m);
}

/** A memo read while its writer's nested check was still running got an unfinished bound: take it again at the end. */
export function settleMemos(nested: Nested): void {
  if (nested.memos) for (const m of nested.memos) restOn(nested, m);
}

/**
 * ctx.cache as one context sees it. The values live in `entries`, shared by the model's contexts of the request; every
 * Map member is overridden, so the view's own (empty) storage is never read.
 */
export class ModelMemo extends Map<string, unknown> {
  readonly #entries: Map<string, MemoEntry>;
  readonly #nested: Nested;
  readonly #now: number;

  constructor(entries: Map<string, MemoEntry>, nested: Nested, now: number) {
    super();
    this.#entries = entries;
    this.#nested = nested;
    this.#now = now;
  }

  get(key: string): unknown {
    return this.#read(key)?.value;
  }

  has(key: string): boolean {
    return this.#read(key) !== undefined;
  }

  set(key: string, value: unknown): this {
    this.#entries.set(key, new MemoEntry(value, this.#nested));
    return this;
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#snapshot().size;
  }

  keys(): MapIterator<string> {
    return this.#snapshot().keys();
  }

  values(): MapIterator<unknown> {
    return this.#snapshot().values();
  }

  entries(): MapIterator<[string, unknown]> {
    return this.#snapshot().entries();
  }

  [Symbol.iterator](): MapIterator<[string, unknown]> {
    return this.#snapshot()[Symbol.iterator]();
  }

  forEach(callback: (value: unknown, key: string, map: Map<string, unknown>) => void, thisArg?: unknown): void {
    this.#snapshot().forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  /** The entry when it is still within its bound; reading it makes this context's call tree rest on it. */
  #read(key: string): MemoEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (!this.#serves(entry)) {
      this.#entries.delete(key);
      return undefined;
    }
    restOn(this.#nested, entry.bound);
    return entry;
  }

  #serves(entry: MemoEntry): boolean {
    return entry.bound.until === undefined || this.#now < entry.bound.until.getTime();
  }

  #snapshot(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const key of [...this.#entries.keys()]) {
      const entry = this.#read(key);
      if (entry !== undefined) out.set(key, entry.value);
    }
    return out;
  }
}
