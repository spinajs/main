import type { AuthzTx } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { sortedUnique } from '@spinajs/util';

import { AdminMembershipStore } from '../admin/ports.js';
import { latestPerSet } from '../membership/closure.js';
import type { MembershipRow } from '../membership/closure.js';
import { requireTransaction } from './context.js';
import { withDbRbacStore } from './db-store.js';
import { whereLive } from './queries.js';
import { MembershipRecord, fromDateTime, recordValues, toDateTime } from './records.js';
import type { MembershipFields } from './records.js';

const toRow = (r: MembershipFields): MembershipRow => ({ memberKey: r.member_key, setKey: r.set_key, depth: r.depth, expiresAt: fromDateTime(r.expires_at) });

/**
 * `MembershipStore` over `authz_subject_membership`, on the `authz` connection.
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
    await this.ready();
    return latestPerSet((await this.select('member_key', memberKeys, at)).map(toRow));
  }

  async membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    await this.ready();
    return sortedUnique((await this.select('set_key', [setKey], at)).map((r) => r.member_key));
  }

  async rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]> {
    await this.ready();
    return (await this.select('member_key', memberKeys)).map(toRow);
  }

  async allMembersOf(setKeys: readonly string[]): Promise<readonly string[]> {
    await this.ready();
    return sortedUnique((await this.select('set_key', setKeys)).map((r) => r.member_key));
  }

  async memberKeys(): Promise<readonly string[]> {
    await this.ready();
    return sortedUnique((await MembershipRecord.query().columns(['member_key'])).map((r) => r.member_key));
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    await this.ready();
    requireTransaction(MembershipRecord, tx, `${this.name}.replace`);
    await MembershipRecord.destroy().where('member_key', memberKey);
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
