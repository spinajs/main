/**
 * Best-effort caller-frame capture for the `${callsite}` layout variable.
 *
 * NLog gates stack-trace capture behind `StackTraceUsage` so that logging is
 * zero-cost unless a target's layout actually references the caller. This
 * mirrors that: {@link FrameworkLogger} only calls {@link captureCallsite}
 * when some target's layout references `${callsite}`, so the `new Error()`
 * ( the only cost here ) is never constructed otherwise.
 *
 * The parser is intentionally defensive - it must NEVER throw. Browser stack
 * formats vary and V8's format is not guaranteed, so an unparseable stack just
 * yields `""` rather than crashing a log call.
 */

/**
 * Walk the current stack and return the first frame OUTSIDE the log package -
 * i.e. the user's call site - as `"basename:line"` ( e.g. `service.ts:42` ).
 *
 * Internal frames belonging to the logger itself ( `log.ts`, `callsite.ts`,
 * the `log-common` package, `wrapWrite`, `createLogMessageObject` ) are skipped
 * so the returned frame is the caller of `log.info(...)` / `log.error(...)`.
 *
 * Returns `""` when no frame can be parsed ( no stack, or an unrecognized
 * stack format ). Best-effort by design.
 */
export function captureCallsite(): string {
  const stack = new Error().stack;
  if (!stack) {
    return "";
  }

  const lines = stack.split("\n");
  for (const line of lines) {
    // only real stack frames ( "    at ..." ) - skip the leading "Error" line
    // and any non-frame text.
    if (!/\bat\b/.test(line)) {
      continue;
    }

    // skip frames that live inside the logger's own code:
    //  - files log.ts / callsite.ts ( source ) or log.js / callsite.js ( built )
    //  - anything under a `log` or `log-common` package's src/ or lib/ tree
    //  - the internal helpers wrapWrite / createLogMessageObject
    if (/[\\/]log(-common)?[\\/](src|lib)[\\/]|[\\/](log|callsite)\.(ts|js|mjs|cjs)\b|\bwrapWrite\b|\bcreateLogMessageObject\b|\bcaptureCallsite\b/.test(line)) {
      continue;
    }

    // extract "path:line" from either:
    //   "    at fn (path:line:col)"   ( named frame )
    //   "    at path:line:col"        ( anonymous frame )
    const m = line.match(/\(?([^()]+):(\d+):(\d+)\)?\s*$/);
    if (m) {
      // basename only - keeps rendered log lines short and stable across
      // machines ( full absolute paths differ per checkout ).
      const file = m[1].split(/[\\/]/).pop() ?? m[1];
      return `${file}:${m[2]}`;
    }
  }

  return "";
}
