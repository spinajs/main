import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';
import { UserSession, adaptLegacySession, decodeSessionData } from '@spinajs/authn-session';
import { refKey, sessionDataFromColumn } from '../session-row.js';

const TABLE = 'user_sessions';
const INDEXES: Record<string, string> = {
  Subject: 'user_sessions_subject_idx',
  ImpersonatorId: 'user_sessions_impersonator_idx',
};

/**
 * 3.0 session rows: `SessionId` holds sha256(raw id) as 64 hex chars; Subject,
 * ImpersonatorId (principal keys, indexed for A08 / SR-06) and State get their
 * own columns. `State` has no default: NULL marks a 2.x row, and a default
 * `'active'` would activate 2.x rows that never passed 2FA (SR-07). `UserId`
 * becomes nullable, so its ON DELETE CASCADE no longer ends 3.0 sessions.
 *
 * Existing rows are backfilled from their Data and keep their raw keys; the
 * issuer re-keys each on first use. Rows 2.x instances write during a rolling
 * upgrade stay Subject NULL and the store adapts them on read.
 *
 * Widening SessionId / relaxing UserId is a modify per column, which the driver
 * spells its own way (sqlite rebuilds the table); every stored id is a 36 char
 * uuid, so VARCHAR(64) fits whatever the current length is.
 */
@Migration('session-provider-connection')
export class UserSessionIdHash_2026_10_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists(TABLE))) {
      return;
    }

    const before = await this.columns(connection);
    const added: string[] = [];
    for (const [name, length] of [
      ['Subject', 100],
      ['ImpersonatorId', 100],
      ['State', 16],
    ] as const) {
      if (!before.has(name.toLowerCase())) {
        // One ALTER per column: the builder runs several through Promise.all.
        await connection.schema().alterTable(TABLE, (table) => {
          table.string(name, length);
        });
        added.push(name);
      }
    }

    if (before.get('userid')?.Nullable === false) {
      await connection.schema().alterTable(TABLE, (table) => {
        table.string('SessionId', 64).notNull().modify();
      });
      await connection.schema().alterTable(TABLE, (table) => {
        table.int('UserId').modify();
      });
    }

    for (const column of added.filter((c) => c in INDEXES)) {
      await connection.index().table(TABLE).name(INDEXES[column]).columns([column]);
    }

    await this.backfill(connection);
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists(TABLE))) {
      return;
    }

    const present = await this.columns(connection);

    for (const column of ['Subject', 'ImpersonatorId', 'State']) {
      if (present.has(column.toLowerCase())) {
        // sqlite refuses to drop an indexed column
        if (column in INDEXES) await connection.index().table(TABLE).name(INDEXES[column]).drop();
        await connection.schema().alterTable(TABLE, (table) => {
          table.dropColumn(column);
        });
      }
    }
  }

  protected async columns(connection: OrmDriver): Promise<Map<string, { Nullable: boolean }>> {
    return new Map((await connection.tableInfo(TABLE)).map((c) => [c.Name.toLowerCase(), c]));
  }

  protected async backfill(connection: OrmDriver): Promise<void> {
    const rows = (await connection.select().from(TABLE).whereNull('Subject')) as Array<{ SessionId: string; Data: unknown }>;

    for (const row of rows) {
      let data: Map<string, unknown>;
      try {
        data = decodeSessionData(sessionDataFromColumn(row.Data));
      } catch {
        // An undecodable row has no readable owner; leave it for expiry rather than fail the migration.
        continue;
      }
      const session = adaptLegacySession(new UserSession({ SessionId: row.SessionId, Data: data }));
      if (!session) {
        continue;
      }

      await connection
        .update()
        .in(TABLE)
        .update({
          Subject: refKey(session.Subject),
          ImpersonatorId: session.Impersonator ? refKey(session.Impersonator) : null,
          State: session.State,
        })
        .where('SessionId', row.SessionId)
        .whereNull('Subject');
    }
  }
}
