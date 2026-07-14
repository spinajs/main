/**
 * Pure, dependency-free serialization helpers used by the log targets.
 *
 * These functions are intentionally browser-safe: they use no Node-only APIs
 * ( no `util`, no `Buffer` ), only plain ECMAScript. They are also written to
 * be defensive - neither of them may ever throw, because a logger that crashes
 * while trying to log an error is worse than useless.
 */

/**
 * Structured representation of an Error suitable for JSON serialization.
 */
export interface ISerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  signal?: string;
}

/**
 * Max depth we walk down the `.cause` chain. A self-referential cause
 * ( `err.cause = err` ) would otherwise loop forever, so we cap the walk.
 */
const MAX_CAUSE_DEPTH = 10;

/**
 * Best-effort read of a property that might be defined via a throwing getter.
 * Returns `undefined` instead of propagating the throw.
 */
function safeGet(obj: unknown, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Returns the most useful string form of an error for embedding in a stack:
 * its `.stack` when available, otherwise its `.message`, otherwise `String()`.
 */
function errorText(err: Error): string {
  const stack = safeGet(err, "stack");
  if (typeof stack === "string" && stack.length > 0) {
    return stack;
  }

  const message = safeGet(err, "message");
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  try {
    return String(err);
  } catch {
    return "[unserializable error]";
  }
}

/**
 * Builds a combined stack string that walks the `.cause` chain and, for
 * `AggregateError`, its inner `errors`. Mirrors bunyan's `getFullErrorStack`:
 * each nested error is appended under a `Caused by:` line.
 *
 * `seen` guards against cycles ( shared cause objects ) and `depth` caps how
 * far down the chain we recurse, so a self-referential cause cannot hang.
 */
function buildFullStack(err: Error, seen: Set<unknown>, depth: number): string {
  let out = errorText(err);

  if (depth >= MAX_CAUSE_DEPTH || seen.has(err)) {
    return out;
  }
  seen.add(err);

  // Follow the standard `.cause` chain ( ES2022 error cause ).
  const cause = safeGet(err, "cause");
  if (cause instanceof Error && !seen.has(cause)) {
    out += "\nCaused by: " + buildFullStack(cause, seen, depth + 1);
  }

  // AggregateError ( or any error carrying an `errors` array ) - surface each
  // inner error under the same `Caused by:` style.
  const errors = safeGet(err, "errors");
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      if (inner instanceof Error && !seen.has(inner)) {
        out += "\nCaused by: " + buildFullStack(inner, seen, depth + 1);
      }
    }
  }

  return out;
}

/**
 * Turn an `Error` into a plain, JSON-friendly record.
 *
 * - Returns `undefined` for anything that is not an `Error` ( callers only
 *   serialize actual errors ).
 * - `stack` walks the `.cause` chain and any `AggregateError.errors`, appending
 *   each nested error under a `Caused by:` line ( bunyan-style ).
 * - `code` / `signal` are included only when present ( common on Node system
 *   errors such as `ECONNREFUSED` / `SIGTERM` ).
 * - Never throws.
 */
export function serializeError(err: unknown): ISerializedError | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }

  try {
    const name = typeof err.name === "string" ? err.name : "Error";
    const message = typeof err.message === "string" ? err.message : "";

    const result: ISerializedError = { name, message };

    const stack = buildFullStack(err, new Set<unknown>(), 0);
    if (stack.length > 0) {
      result.stack = stack;
    }

    // Node system errors carry a `code` ( e.g. 'ECONNREFUSED' ) and sometimes a
    // `signal` ( e.g. 'SIGTERM' ). Include them only when actually present.
    const code = safeGet(err, "code");
    if (typeof code === "string" || typeof code === "number") {
      result.code = code;
    }

    const signal = safeGet(err, "signal");
    if (typeof signal === "string") {
      result.signal = signal;
    }

    return result;
  } catch {
    // Absolute last-resort guard - serialization must never throw.
    return { name: "Error", message: "[unserializable error]" };
  }
}

/**
 * JSON-stringify any value without ever throwing.
 *
 * Three tiers:
 *   1. plain `JSON.stringify` ( the common, fast path );
 *   2. on throw ( typically circular references ) retry with a replacer that
 *      swaps already-seen objects for the string `"[Circular]"`, producing
 *      VALID JSON;
 *   3. if that still throws ( e.g. a getter that throws while enumerating ),
 *      fall back to `String(value)`.
 */
export function safeStringify(value: unknown, indent?: number): string {
  try {
    // Tier 1: the fast, common path.
    return JSON.stringify(value, undefined, indent);
  } catch {
    // Tier 2: handle circular references with a WeakSet of seen objects.
    try {
      const seen = new WeakSet<object>();
      const replacer = (_key: string, val: unknown): unknown => {
        if (val !== null && typeof val === "object") {
          if (seen.has(val as object)) {
            return "[Circular]";
          }
          seen.add(val as object);
        }
        return val;
      };
      return JSON.stringify(value, replacer, indent);
    } catch {
      // Tier 3: something else threw ( e.g. a throwing getter ). Give up on
      // structured output but still return *a* string.
      try {
        return String(value);
      } catch {
        return "[unserializable value]";
      }
    }
  }
}
