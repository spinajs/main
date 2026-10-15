import { createHash } from 'crypto';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// not right after a word character, so the apostrophe in "can't" does not open a quote
const QUOTED = /(?<!\w)(["'`])(?:\\.|(?!\1).)*\1/g;
const PATH = /(?:[a-zA-Z]:)?(?:[\\/][\w.@-]+){2,}/g;
const HEX = /\b0x[0-9a-f]+\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;
const FRAME = /^at (?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/;
const OUTSIDE_APP = /node_modules|^node:|^internal\//;

/** Replaces the parts of a message that vary between occurrences of the same failure. */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID, '<uuid>')
    .replace(QUOTED, '<str>')
    .replace(PATH, '<path>')
    .replace(HEX, '<hex>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First stack frame outside dependencies and node internals, as `function (file basename)`:
 * line numbers and install paths change between deploys and hosts and must not split a group.
 */
export function topInAppFrame(stack?: string): string | null {
  if (!stack) return null;
  for (const raw of stack.split('\n').slice(1)) {
    const m = FRAME.exec(raw.trim());
    if (!m || OUTSIDE_APP.test(m[2])) continue;
    const file = m[2].split(/[\\/]/).pop() || m[2];
    // V8 prefixes frames resumed after an await with `async `; it is the same function
    const fn = m[1]?.replace(/^async /, '') ?? '<anonymous>';
    return `${fn} (${file})`;
  }
  return null;
}

export function computeFingerprint(schedule: string, e: { name: string; message: string; stack?: string }): string {
  return createHash('sha256')
    .update([schedule, e.name, normalizeMessage(e.message), topInAppFrame(e.stack) ?? ''].join('\n'))
    .digest('hex')
    .slice(0, 32);
}
