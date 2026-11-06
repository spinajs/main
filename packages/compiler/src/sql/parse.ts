import NodeSqlParser from 'node-sql-parser';
import type { SqlDialectProfile } from '@spinajs/manifest';

/** One node of the parser's AST; its shape differs per grammar, so it is read field by field. */
export type SqlNode = Record<string, unknown>;

/** `valuesRow`: the grammar rejected an INSERT whose VALUES row (1-based) has more or fewer values than the column list. */
export type ParseResult = { ok: true; statements: SqlNode[] } | { ok: false; message: string; valuesRow?: number };

const CLOSERS: Readonly<Record<string, string>> = { "'": "'", '"': '"', '`': '`', '[': ']' };

const spanEnd = (text: string, open: string, close: string, start: number): number => {
  const end = text.indexOf(close, start + open.length);
  return end === -1 ? text.length : end + close.length;
};

/**
 * End of the quoted name, string literal or comment that starts at `start`, or `start` when none does. Only `dollar` and
 * `at-p0` text gets here (`bindParameters` returns `question` text unchanged), so MySQL's `\'` escape is not handled;
 * PostgreSQL's `E'…'` escape string is, and so is the untagged `$$…$$` string. A tagged `$tag$…$tag$` is not.
 */
function literalEnd(text: string, start: number): number {
  if (text.startsWith('--', start)) {
    const end = text.indexOf('\n', start);
    return end === -1 ? text.length : end;
  }
  if (text.startsWith('/*', start)) return spanEnd(text, '/*', '*/', start);
  if (text.startsWith('$$', start)) return spanEnd(text, '$$', '$$', start);
  const escaped = (text[start] === 'E' || text[start] === 'e') && text[start + 1] === "'";
  const open = escaped ? start + 1 : start;
  const close = CLOSERS[text[open]];
  if (!close) return start;
  for (let i = open + 1; i < text.length; i += 1) {
    if (escaped && text[i] === '\\') i += 1;
    else if (text[i] === close) return i + 1;
  }
  return text.length;
}

/** `?|` and `?&` are jsonb operators; `?||` is a placeholder before `||`. The postgres driver's `toDriverStatement` reads them the same way. */
const isJsonbOperator = (text: string, i: number): boolean => text.startsWith('?&', i) || (text.startsWith('?|', i) && text[i + 2] !== '|');

/** The text as the driver sends it, which is the form its grammar accepts. */
export function bindParameters(text: string, style: SqlDialectProfile['placeholders']): string {
  if (style === 'question') return text;
  let out = '';
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const end = literalEnd(text, i);
    if (end > i) {
      out += text.slice(i, end);
      i = end;
    } else if (style === 'dollar' && isJsonbOperator(text, i)) {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += text[i] !== '?' ? text[i] : style === 'dollar' ? `$${n + 1}` : `@p${n}`;
      if (text[i] === '?') n += 1;
      i += 1;
    }
  }
  return out;
}

function syntaxMessage(err: unknown): string {
  const e = err as { found?: unknown; location?: { start?: { line?: number } }; message?: unknown };
  const line = e.location?.start?.line;
  if (line === undefined) return String(e.message ?? err);
  const found = typeof e.found === 'string' ? `unexpected "${e.found}"` : 'unexpected end of query';
  return `${found} on line ${line} of the query`;
}

const VALUE_COUNT = /column count doesn't match value count at row (\d+)/;

// node-sql-parser is CommonJS without named ESM exports, so `import { Parser }` fails at runtime.
const parser = new NodeSqlParser.Parser();

export function parseSql(text: string, profile: SqlDialectProfile): ParseResult {
  try {
    const ast = parser.astify(bindParameters(text, profile.placeholders), { database: profile.grammar }) as unknown;
    return { ok: true, statements: (Array.isArray(ast) ? ast : [ast]) as SqlNode[] };
  } catch (err) {
    const count = VALUE_COUNT.exec(String((err as { message?: unknown }).message));
    if (count) return { ok: false, message: count[0], valuesRow: Number(count[1]) };
    return { ok: false, message: syntaxMessage(err) };
  }
}
