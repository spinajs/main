/**
 * Rewrites the first `count` `?` placeholders into `@p0..`; a statement without bindings is left alone, any `?` in it is text.
 * A `?` inside a '...' or "..." literal or a [...] identifier is text too.
 */
export function toNamedParameters(stmt: string, count: number): string {
  let out = '';
  let index = 0;
  let closing: string | null = null;

  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt.charAt(i);

    if (closing) {
      out += ch;
      if (ch === closing) {
        // a doubled closing character is an escaped one, not the end of the literal
        if (stmt.charAt(i + 1) === closing) {
          out += stmt.charAt(++i);
        } else {
          closing = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      closing = ch;
    } else if (ch === '[') {
      closing = ']';
    } else if (ch === '?' && index < count) {
      out += `@p${index++}`;
      continue;
    }

    out += ch;
  }

  return out;
}
