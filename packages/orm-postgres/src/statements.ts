import { NewInstance } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';

/**
 * PostgreSQL quotes identifiers with the ANSI double quote and escapes an embedded `"` by
 * doubling it. The shared `orm-sql` helper emits backticks, which PostgreSQL reads as an
 * operator error, so the driver carries its own escaper for its internal SQL ( savepoint
 * names, schema probes ) the same way MSSQL does.
 */
export function pgEscapeIdentifier(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * The ANSI double quote — PostgreSQL's identifier quoting. Registered by the postgres
 * driver as its {@link IdentifierQuoter}, never inherited: MySQL rejects `"` as an
 * identifier quote unless ANSI_QUOTES is on, so nothing here is portable either way.
 */
@NewInstance()
export class DoubleQuoteIdentifierQuoter extends IdentifierQuoter {
  public quote(name: string): string {
    return pgEscapeIdentifier(name);
  }
}
