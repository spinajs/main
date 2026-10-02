interface UuidSource {
  randomUUID?: () => string;
}

/** crypto.randomUUID is missing in insecure (plain http) browser contexts, hence the fallback. */
export function randomId(source: UuidSource | undefined = (globalThis as { crypto?: UuidSource }).crypto): string {
  if (source?.randomUUID) return source.randomUUID();
  const part = (): string => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${part()}-${part()}-${part()}`;
}
