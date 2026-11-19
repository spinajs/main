import { QUOTED } from './sql-tokens.js';

const QUOTED_ALL = new RegExp(QUOTED.source, 'g');
const DATA_CHANGING = /\b(?:insert|update|delete|merge|replace|create|drop|alter|truncate)\b/i;

// A comment (`--`, `/*`, `#`), a dollar quote and a backslash escape can each hold a lone quote character.
const UNREADABLE = /--|\/\*|[#$\\]/;

/**
 * Whether `sql` is one statement that only reads. EXPLAIN without ANALYZE never runs the statement, but postgres
 * runs whatever follows a `;` when the call has no parameters. Quotes are not paired to find a `;` "inside a
 * string": a lone quote in a comment or a dollar-quoted string would pair with a later one and hide it.
 */
export function isExplainable(sql: string): boolean {
  const text = sql.trim().replace(/;$/, '').trim();
  if (text.includes(';') || UNREADABLE.test(text)) {
    return false;
  }
  if (/^select\b/i.test(text)) {
    return true;
  }
  return /^with\b/i.test(text) && !DATA_CHANGING.test(text.replace(QUOTED_ALL, "''"));
}
