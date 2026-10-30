export interface Placeholder {
  name: string;
  splat: boolean;
  /** Inside an Express 5 `{...}` optional group. */
  optional: boolean;
}

export interface ClientPath {
  /** The runtime template: `{name}`, `{*name}`, `[...]` optional groups, `\` escapes. */
  template: string;
  placeholders: Placeholder[];
}

const NAME = /^[$_A-Za-z][$\w]*/;
const QUOTED = /^"((?:[^"\\]|\\.)+)"/;
const TEMPLATE_SPECIAL = /[{}[\]\\]/;

export class UnsupportedPathError extends Error {}

interface Cursor {
  path: string;
  i: number;
  depth: number;
  out: string;
  placeholders: Placeholder[];
}

function readName(cursor: Cursor): string {
  const rest = cursor.path.slice(cursor.i + 1);
  const quoted = QUOTED.exec(rest);
  const match = quoted ?? NAME.exec(rest);
  if (!match) throw new UnsupportedPathError(`a parameter name is missing at index ${cursor.i}`);
  const name = quoted ? quoted[1].replace(/\\(.)/g, '$1') : match[0];
  if (TEMPLATE_SPECIAL.test(name)) throw new UnsupportedPathError(`parameter name '${name}' holds a brace, bracket or backslash`);
  cursor.i += 1 + match[0].length;
  return name;
}

function literalChar(cursor: Cursor, char: string): void {
  cursor.out += TEMPLATE_SPECIAL.test(char) ? `\\${char}` : char;
}

function step(cursor: Cursor): void {
  const char = cursor.path[cursor.i];
  if (char === ':' || char === '*') {
    const splat = char === '*';
    const name = readName(cursor);
    cursor.placeholders.push({ name, splat, optional: cursor.depth > 0 });
    cursor.out += splat ? `{*${name}}` : `{${name}}`;
  } else if (char === '{' || char === '}') {
    cursor.depth += char === '{' ? 1 : -1;
    if (cursor.depth < 0) throw new UnsupportedPathError(`unbalanced '}' at index ${cursor.i}`);
    cursor.out += char === '{' ? '[' : ']';
    cursor.i++;
  } else if (char === '\\' && cursor.i + 1 < cursor.path.length) {
    literalChar(cursor, cursor.path[cursor.i + 1]);
    cursor.i += 2;
  } else if ('()[]?+!'.includes(char)) {
    // Reserved by path-to-regexp 8, which Express 5 refuses at startup.
    throw new UnsupportedPathError(`'${char}' at index ${cursor.i} is reserved`);
  } else {
    literalChar(cursor, char);
    cursor.i++;
  }
}

/** Reads an Express 5 (path-to-regexp 8) route path: `:name`, `*name`, `{...}` optional groups and `\` escapes. */
export function clientPath(path: string): ClientPath {
  const cursor: Cursor = { path, i: 0, depth: 0, out: '', placeholders: [] };
  while (cursor.i < path.length) step(cursor);
  if (cursor.depth !== 0) throw new UnsupportedPathError(`an optional group is not closed`);
  return { template: cursor.out, placeholders: cursor.placeholders };
}
