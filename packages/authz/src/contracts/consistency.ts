// The token's text is opaque to callers; the prefix keeps another system's token from passing for a generation.
const PREFIX = 'spina:g:';

/** The opaque consistency token of store generation `generation` (`DecisionRequest.consistency.atLeast`). */
export function consistencyToken(generation: number): string {
  return Buffer.from(`${PREFIX}${generation}`, 'utf8').toString('base64url');
}

/** The generation a consistency token names; undefined for a string that is not such a token. */
export function tokenGeneration(token: string): number | undefined {
  const text = Buffer.from(token, 'base64url').toString('utf8');
  if (!text.startsWith(PREFIX)) return undefined;
  const digits = text.slice(PREFIX.length);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(digits)) return undefined;
  const generation = Number(digits);
  return Number.isSafeInteger(generation) ? generation : undefined;
}
