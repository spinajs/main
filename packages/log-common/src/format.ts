/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal, platform-free clone of Node's `util.format`.
 *
 * Supports the format specifiers the framework actually uses:
 *   %s  - String
 *   %d  - Number ( integer )
 *   %i  - parseInt
 *   %f  - parseFloat
 *   %j  - JSON
 *   %o  - Object ( JSON.stringify )
 *   %O  - Object ( JSON.stringify )
 *   %%  - literal percent sign ( consumes no argument )
 *
 * Any arguments left over after the specifiers are consumed are appended,
 * space-separated. Objects are rendered via JSON.stringify ( circular refs
 * fall back to String() ). This avoids pulling in Node's `util` module so the
 * logger is usable in the browser.
 */
export function format(f?: any, ...args: any[]): string {
  if (typeof f !== 'string') {
    // no format string: join everything space-separated
    return [f, ...args].map((a) => inspect(a)).join(' ');
  }

  let argIndex = 0;
  const str = f.replace(/%[sdifjoO%]/g, (match: string): string => {
    if (match === '%%') {
      return '%';
    }

    if (argIndex >= args.length) {
      return match;
    }

    const arg = args[argIndex++];
    switch (match) {
      case '%s':
        return typeof arg === 'object' && arg !== null ? inspect(arg) : String(arg);
      case '%d':
        return String(Number(arg));
      case '%i':
        return String(parseInt(arg as any, 10));
      case '%f':
        return String(parseFloat(arg as any));
      case '%j':
      case '%o':
      case '%O':
        return inspect(arg);
      default:
        return match;
    }
  });

  if (argIndex >= args.length) {
    return str;
  }

  // append remaining args space-separated
  const rest = args.slice(argIndex).map((a) => (typeof a === 'string' ? a : inspect(a)));
  return [str, ...rest].join(' ');
}

function inspect(value: any): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
