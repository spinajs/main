/** `undefined` for values JSON cannot represent (cycles, BigInt, a bare function). */
export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
