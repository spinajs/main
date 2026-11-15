/** A template carrying this comment is not checked by the doctor or the ESLint rule. */
export const SQL_IGNORE_MARKER = 'spinajs-sql-ignore';

// DML only (A11): DDL, VALUES, MERGE, EXPLAIN and SHOW templates are recorded but, like fragments, neither analyzed nor listed.
const STATEMENT = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*(?:select|insert|update|delete|with|replace)\b/i;

/** The SQL text of a `sql` template as the doctor sees it: every interpolation is one `?`. */
export function renderSqlTemplate(strings: readonly string[]): string {
  return strings.join('?');
}

/** A whole DML statement, not a condition or column list built to be spliced into one. */
export function isSqlStatement(text: string): boolean {
  return STATEMENT.test(text);
}
