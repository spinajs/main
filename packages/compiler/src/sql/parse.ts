import NodeSqlParser from 'node-sql-parser';
import type { SqlDialect } from './dialects.js';

/** One node of the parser's AST; its shape differs per grammar, so it is read field by field. */
export type SqlNode = Record<string, unknown>;

/** `valuesRow`: the grammar rejected an INSERT whose VALUES row (1-based) has more or fewer values than the column list. */
export type ParseResult = { ok: true; statements: SqlNode[] } | { ok: false; message: string; valuesRow?: number };

const DATABASES: Readonly<Record<SqlDialect, string>> = { postgresql: 'PostgresQL', mysql: 'MySQL', sqlite: 'Sqlite', transactsql: 'TransactSQL' };

const CLOSERS: Readonly<Record<string, string>> = { "'": "'", '"': '"', '`': '`', '[': ']' };

const spanEnd = (text: string, open: string, close: string, start: number): number => {
  const end = text.indexOf(close, start + open.length);
  return end === -1 ? text.length : end + close.length;
};

/**
 * End of the quoted name, string literal or comment that starts at `start`, or `start` when none does. Only PostgreSQL and
 * T-SQL text gets here (`bindParameters` returns mysql and sqlite text unchanged), so MySQL's `\'` escape is not handled;
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

/** The `sql` tag binds `?`. The PostgreSQL and T-SQL grammars accept only `$n` and `@pn`, which is how those drivers send it. */
export function bindParameters(text: string, dialect: SqlDialect): string {
  if (dialect === 'mysql' || dialect === 'sqlite') return text;
  let out = '';
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const end = literalEnd(text, i);
    if (end > i) {
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === '?') {
      n += 1;
      out += dialect === 'postgresql' ? `$${n}` : `@p${n}`;
    } else {
      out += text[i];
    }
    i += 1;
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

export function parseSql(text: string, dialect: SqlDialect): ParseResult {
  try {
    const ast = parser.astify(bindParameters(text, dialect), { database: DATABASES[dialect] }) as unknown;
    return { ok: true, statements: (Array.isArray(ast) ? ast : [ast]) as SqlNode[] };
  } catch (err) {
    const count = VALUE_COUNT.exec(String((err as { message?: unknown }).message));
    if (count) return { ok: false, message: count[0], valuesRow: Number(count[1]) };
    return { ok: false, message: syntaxMessage(err) };
  }
}
