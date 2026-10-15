import type { AuthzTx } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { AdminMembershipStore } from '../admin/ports.js';
import { latestPerSet } from '../membership/closure.js';
import type { MembershipRow } from '../membership/closure.js';
import { toDate } from './columns.js';
import { storeConnection, storeTransactionDriver } from './context.js';
import { whereLive } from './queries.js';

export const AUTHZ_SUBJECT_MEMBERSHIP_TABLE = 'authz_subject_membership';

const KEY_BATCH = 500;
// 4 columns a row: 800 bound parameters, under SQLite's 999.
const INSERT_BATCH = 200;

interface StoredRow {
  readonly member_key: string;
  readonly set_key: string;
  readonly depth: number | string;
  readonly expires_at: Date | string | null;
}

const toRow = (r: StoredRow): MembershipRow => ({ memberKey: String(r.member_key), setKey: String(r.set_key), depth: Number(r.depth), expiresAt: toDate(r.expires_at) });
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * `MembershipStore` over `authz_subject_membership` (design §4.3), on the `authz.rbac.connection` connection.
 * The RBAC write handlers keep it right inside each AuthzAdmin batch; `authz:membership-rebuild` rewrites it.
 * Registered by class name; `authz.rbac.stores.membership` selects it.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbMembershipStore extends AdminMembershipStore {
  readonly name: string = 'DbMembershipStore';

  constructor(protected readonly container: IContainer) {
    super();
  }

  async setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return latestPerSet((await this.select('member_key', memberKeys, at)).map(toRow));
  }

  async membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    return sorted((await this.select('set_key', [setKey], at)).map((r) => r.member_key));
  }

  async rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]> {
    return (await this.select('member_key', memberKeys)).map(toRow);
  }

  async allMembersOf(setKeys: readonly string[]): Promise<readonly string[]> {
    return sorted((await this.select('set_key', setKeys)).map((r) => r.member_key));
  }

  async memberKeys(): Promise<readonly string[]> {
    const driver = await this.connection();
    return sorted(((await driver.select().from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE).columns(['member_key'])) as unknown as StoredRow[]).map((r) => r.member_key));
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    const driver = storeTransactionDriver(tx, await this.connection(), `${this.name}.replace`);
    await driver.del().from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE).where('member_key', memberKey);
    const values = rows.map((r) => ({ member_key: memberKey, set_key: r.setKey, depth: r.depth, expires_at: r.expiresAt }));
    for (let i = 0; i < values.length; i += INSERT_BATCH) {
      await driver
        .insert()
        .into(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)
        .values(values.slice(i, i + INSERT_BATCH));
    }
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** Rows whose `column` is one of `keys`, in batches; `at` undefined keeps expired rows. */
  private async select(column: 'member_key' | 'set_key', keys: readonly string[], at?: Date): Promise<StoredRow[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const driver = await this.connection();
    const out: StoredRow[] = [];
    for (let i = 0; i < unique.length; i += KEY_BATCH) {
      const query = driver
        .select()
        .from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)
        .whereIn(column, unique.slice(i, i + KEY_BATCH));
      if (at) whereLive(query, at);
      out.push(...((await query) as unknown as StoredRow[]));
    }
    return out;
  }
}
