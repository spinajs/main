import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/**
 * Conditional tuples: the caveat name, the hash list plans filter on, the canonical context. Unconditional rows keep
 * NULLs. `caveat_context` is text because its limit (CAVEAT_CONTEXT_MAX, checked on write) exceeds some varchar limits.
 */
@Migration(AUTHZ_CONNECTION)
export class AuthzRebacCaveats_2026_11_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('authz_rebac_tuple', (table) => {
      table.string('caveat', 64);
      table.string('caveat_key', 64);
      table.text('caveat_context');
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
