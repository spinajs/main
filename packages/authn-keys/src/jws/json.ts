const LONE_SURROGATE = /\p{Surrogate}/u;
// serde_json refuses the 128th nested array or object (its recursion limit); canvas C8 refuses it on both sides.
const MAX_DEPTH = 127;
// On text JSON.parse accepted, these are exactly its strings, brackets and numbers.
const TOKENS = /"[^"\\]*(?:\\.[^"\\]*)*"|[[\]{}]|-?[0-9][0-9.eE+-]*/g;
const UINT_TEXT = /^(0|[1-9][0-9]*)$/;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * JSON as serde_json reads it, so this verifier agrees with the canvas C8 Rust one: refuses invalid UTF-8, lone
 * surrogates (escaped or not, keys included, also under a duplicate key), nesting deeper than 127, numbers beyond f64,
 * and top-level `uintKeys` whose number is not written as a plain integer. A duplicate key keeps its last value
 * (RFC 7515 §4 allows that, and both C8 verifiers do it). Undefined when refused; never throws.
 */
export function parseStrictJson(bytes: Uint8Array, uintKeys: readonly string[] = []): unknown {
  try {
    const text = decoder.decode(bytes);
    const loose = new Set<unknown>();
    const value: unknown = JSON.parse(text, function (this: unknown, key: string, v: unknown, context?: { source?: string }) {
      // context.source needs Node 21+; older runtimes still get the safe-integer checks of the caller.
      if (uintKeys.includes(key) && typeof v === 'number' && typeof context?.source === 'string' && !UINT_TEXT.test(context.source)) {
        loose.add(this);
      }
      return v;
    });
    if (loose.has(value)) {
      return undefined;
    }
    let depth = 0;
    for (const [token] of text.matchAll(TOKENS)) {
      if (token === '[' || token === '{') {
        depth += 1;
        if (depth > MAX_DEPTH) {
          return undefined;
        }
      } else if (token === ']' || token === '}') {
        depth -= 1;
      } else if (token.startsWith('"')) {
        if (LONE_SURROGATE.test(JSON.parse(token) as string)) {
          return undefined;
        }
      } else if (!Number.isFinite(Number(token))) {
        return undefined;
      }
    }
    return value;
  } catch {
    return undefined;
  }
}

export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
