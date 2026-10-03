const LONE_SURROGATE = /\p{Surrogate}/u;
// serde_json refuses the 128th nested array or object (its recursion limit); canvas C8 refuses it on both sides.
const MAX_DEPTH = 127;
// On text JSON.parse accepted, these are exactly its strings, brackets and numbers (literals are skipped).
const TOKENS = /"[^"\\]*(?:\\.[^"\\]*)*"|[[\]{}]|-?[0-9][0-9.eE+-]*/g;
const KEY_FOLLOWS = /\s*:/y;
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
    const value: unknown = JSON.parse(text);
    // The number text of each top-level key, the last occurrence winning as in JSON.parse; read from the tokens
    // because the reviver's source text needs Node 21+.
    const numberText = new Map<string, string>();
    const topLevelObject = text.trimStart().startsWith('{');
    let depth = 0;
    let key: string | null = null;
    for (const m of text.matchAll(TOKENS)) {
      const token = m[0];
      const pending = key;
      key = null;
      if (token === '[' || token === '{') {
        depth += 1;
        if (depth > MAX_DEPTH) {
          return undefined;
        }
      } else if (token === ']' || token === '}') {
        depth -= 1;
      } else if (token.startsWith('"')) {
        const s = JSON.parse(token) as string;
        if (LONE_SURROGATE.test(s)) {
          return undefined;
        }
        if (topLevelObject && depth === 1) {
          KEY_FOLLOWS.lastIndex = m.index! + token.length;
          if (KEY_FOLLOWS.test(text)) {
            key = s;
          }
        }
      } else if (!Number.isFinite(Number(token))) {
        return undefined;
      } else if (pending !== null) {
        numberText.set(pending, token);
      }
    }
    for (const k of uintKeys) {
      const t = numberText.get(k);
      if (t !== undefined && !UINT_TEXT.test(t)) {
        return undefined;
      }
    }
    return value;
  } catch {
    return undefined;
  }
}

export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
