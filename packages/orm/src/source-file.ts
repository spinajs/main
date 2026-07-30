/**
 * Walk the current V8 stack and return the absolute path of the first frame that is NOT inside
 * one of `skipMarkers`. Called from a decorator, that frame is the decorated class's own source
 * file. Works for CJS ( `at ... (C:\foo\bar.js:12:3)` ) and ESM ( `at ... (file:///C:/foo/bar.js:12:3)` ).
 *
 * Lifted from `@spinajs/http`'s `captureControllerSourceFile` - the two packages cannot share it
 * without one depending on the other, and http sits above orm in the graph.
 */
export function captureSourceFile(skipMarkers: string[]): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split('\n');

  for (const line of lines) {
    if (skipMarkers.some((m) => line.includes(m))) continue;
    // Match `(path:line:col)` or bare `path:line:col` at the end of the frame.
    const m = line.match(/\(([^()]+):\d+:\d+\)\s*$/) || line.match(/at\s+([^\s()]+):\d+:\d+\s*$/);
    if (!m) continue;

    let file = m[1];

    if (file.startsWith('file://')) {
      try {
        // Strip the ESM url scheme. Windows: file:///C:/foo -> C:/foo, POSIX paths stay as-is.
        file = decodeURIComponent(file.replace(/^file:\/\/\/?/, ''));

        if (!/^[A-Za-z]:/.test(file) && !file.startsWith('/')) {
          file = `/${file}`;
        }
      } catch {
        // fall through with the raw match
      }
    }

    return file;
  }

  return undefined;
}
