import { NewInstance } from '@spinajs/di';

/**
 * Quotes identifiers — table, column and alias names — the way one dialect spells them.
 *
 * Resolved from the DRIVER's container like every other compiler and statement, so a
 * driver picks its quoting the same way it picks its SQL. This used to be a module-level
 * function in `@spinajs/orm-sql` that emitted backticks and was imported directly by
 * nearly every shared statement and compiler — including MSSQL's own, which therefore
 * produced `` `table` `` where SQL Server needs `[table]`. Shadowing a compiler cannot
 * shadow a function it calls internally, so quoting had to become a service before the
 * "each driver registers its own dialect" rule could hold for identifiers at all.
 *
 * There is deliberately NO default registration. Backticks are MySQL and SQLite;
 * brackets are MSSQL; the ANSI double quote is rejected by MySQL unless `ANSI_QUOTES` is
 * on. Nothing is portable here, so nothing is inherited: a driver that registers no
 * quoter fails loudly on its first query instead of emitting another dialect's SQL.
 */
@NewInstance()
export abstract class IdentifierQuoter {
  /**
   * Quotes one identifier, escaping the quote character if the name contains it.
   */
  public abstract quote(name: string): string;

  /**
   * Quotes a possibly schema-qualified name, quoting each dot-separated part on its own:
   * `schema.table` becomes `` `schema`.`table` ``, never `` `schema.table` `` — the latter
   * is a single identifier and every one of these databases rejects it as a table
   * reference.
   *
   * A table whose name genuinely contains a dot cannot be expressed through the APIs that
   * take a qualified name as one string; it never could.
   */
  public quoteQualified(name: string): string {
    return String(name)
      .split('.')
      .map((part) => this.quote(part))
      .join('.');
  }
}
