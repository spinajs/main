// Compiling a builder is synchronous, so one module-level flag sees every raw text a compile pass emits.
let depth = 0;
let emitted = false;

/** Called where caller-written SQL text (a `RawQuery`, a `sql` fragment) goes into a compiled statement. */
export function noteRawSql(): void {
  if (depth > 0) {
    emitted = true;
  }
}

/**
 * Runs `compile` and reports whether it emitted caller-written SQL. Only that text can hold a second statement or a
 * comment; everything else a builder compiles is quoted identifiers, placeholders and the dialect's own keywords.
 */
export function trackRawSql<T>(compile: () => T): [output: T, rawSql: boolean] {
  const outer = emitted;
  emitted = false;
  depth++;
  try {
    const output = compile();
    return [output, emitted];
  } finally {
    depth--;
    emitted = outer || emitted;
  }
}
