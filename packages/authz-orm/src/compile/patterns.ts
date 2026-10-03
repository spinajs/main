// The tokenisers of the reference matchers (packages/authz/src/engine/evaluate.ts): a token is a
// code point or one of these markers. The dialects render the tokens, so every pattern reaches the
// database re-encoded and its own escaping rules never meet the filter's text.
export const ONE = -1;
export const RUN = -2;
export const RUN_NO_SLASH = -3;

const codePoints = (s: string): number[] => Array.from(s, (ch) => ch.codePointAt(0)!);

/** `undefined`: a trailing `\`, which the evaluator reads as UNKNOWN. */
export function likeTokens(pattern: string): number[] | undefined {
  const cps = codePoints(pattern);
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 0x5c) {
      if (i + 1 === cps.length) return undefined;
      out.push(cps[++i]);
    } else out.push(c === 0x25 ? RUN : c === 0x5f ? ONE : c);
  }
  return out;
}

export function globTokens(pattern: string): number[] {
  const cps = codePoints(pattern);
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== 0x2a) out.push(cps[i]);
    else if (cps[i + 1] === 0x2a) {
      out.push(RUN);
      i++;
    } else out.push(RUN_NO_SLASH);
  }
  return out;
}

export function wildcardTokens(pattern: string): number[] {
  return codePoints(pattern).map((c) => (c === 0x2a ? RUN : c));
}

export const isLiteral = (t: number): boolean => t >= 0;

export const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff;

/** A JS string the drivers bind unchanged: no lone surrogate (both encode one as U+FFFD). */
export function wellFormed(s: string): boolean {
  for (const ch of s) if (isSurrogate(ch.codePointAt(0)!)) return false;
  return true;
}
