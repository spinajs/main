import { createHash } from 'node:crypto';

const LITERAL_OR_QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\b\d+(?:\.\d+)?\b/g;
const PLACEHOLDER_LIST = /\(\s*\?(?:\s*,\s*\?)*\s*\)/g;
const ROW_LIST = /\(\?\)(?:\s*,\s*\(\?\))+/g;

function replaceLiterals(sql: string, ansiQuotedIdentifiers: boolean): string {
  return sql.replace(LITERAL_OR_QUOTED, (token) => (token.startsWith('`') || (ansiQuotedIdentifiers && token.startsWith('"')) ? token : '?'));
}

/**
 * The statement with every string and number literal replaced by `?`. A backtick-quoted name stays. A double-quoted
 * token stays only where the connection quotes identifiers that way: MySQL reads it as a string.
 *
 * Whether `\'` ends a literal depends on the server and its mode (MySQL by default, an `E''` string in postgres), and a
 * wrong guess prints the rest of the value. From the literal that holds the first backslash on, the text is dropped.
 */
export function sanitizeSql(sql: string, ansiQuotedIdentifiers = false): string {
  const escape = sql.indexOf('\\');
  if (escape < 0) {
    return replaceLiterals(sql, ansiQuotedIdentifiers);
  }

  const head = replaceLiterals(sql.slice(0, escape), ansiQuotedIdentifiers);
  const open = ansiQuotedIdentifiers ? head.indexOf("'") : head.search(/['"]/);
  return `${open < 0 ? head : head.slice(0, open)}?`;
}

/**
 * A short, stable id of a statement's shape: literal values, whitespace, letter case and the
 * length of `IN (...)` lists and multi-row `VALUES` do not change it.
 */
export function fingerprint(sql: string, ansiQuotedIdentifiers = false): string {
  const shape = sanitizeSql(sql, ansiQuotedIdentifiers).replace(/\s+/g, ' ').replace(PLACEHOLDER_LIST, '(?)').replace(ROW_LIST, '(?)').trim().toLowerCase();
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}
