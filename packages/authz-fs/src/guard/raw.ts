const raws = new WeakMap<object, object>();

export function rememberRaw(guard: object, raw: object): void {
  raws.set(guard, raw);
}

/** The raw provider behind a guard, else the value itself. Internal: the barrel does not export it. */
export function rawFsOf(value: unknown): unknown {
  return (value !== null && typeof value === 'object' && raws.get(value)) || value;
}
