import type { AuthzTx } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AdminMembershipStore } from '../admin/ports.js';
import { latestPerSet } from '../membership/closure.js';
import type { MembershipRow } from '../membership/closure.js';
import { requireTransaction } from './context.js';
import { withDbRbacStore } from './db-store.js';
import { whereLive } from './queries.js';
import { MembershipRecord, deleteFrom, fromDateTime, recordValues, toDateTime } from './records.js';
import type { MembershipFields } from './records.js';

const toRow = (r: MembershipFields): MembershipRow => ({ memberKey: r.member_key, setKey: r.set_key, depth: r.depth, expiresAt: fromDateTime(r.expires_at) });
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * `MembershipStore` over `authz_subject_membership` (design §4.3), on the `authz` connection.
 * The RBAC write handlers keep it right inside each AuthzAdmin batch; `authz:membership-rebuild` rewrites it.
 * Registered by class name; `authz.rbac.stores.membership` selects it.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbMembershipStore extends withDbRbacStore(AdminMembershipStore) {
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
    return sorted((await MembershipRecord.query().columns(['member_key'])).map((r) => r.member_key));
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    requireTransaction(MembershipRecord, tx, `${this.name}.replace`);
    await deleteFrom(MembershipRecord).where('member_key', memberKey);
    await MembershipRecord.insert(rows.map((r) => recordValues<MembershipRecord>({ member_key: memberKey, set_key: r.setKey, depth: r.depth, expires_at: toDateTime(r.expiresAt) })));
  }

  /** Rows whose `column` is one of `keys`; `at` undefined keeps expired rows. */
  private async select(column: 'member_key' | 'set_key', keys: readonly string[], at?: Date): Promise<MembershipRecord[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const query = MembershipRecord.query().whereIn(column, unique);
    if (at) whereLive(query, at);
    return query;
  }
}
