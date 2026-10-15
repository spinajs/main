import { memoryTx } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';

import { latestPerSet } from '../../membership/closure.js';
import type { MembershipRow } from '../../membership/closure.js';
import { AdminMembershipStore } from '../ports.js';
import { isLive } from '../rows.js';

const copy = (r: MembershipRow): MembershipRow => Object.freeze({ ...r, expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt.getTime()) });
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * The closure table in a map, written inside a MemoryAuthzAdminBackend transaction. Not registered: tests and
 * memory hosts register one instance under MembershipStore and AdminMembershipStore.
 */
export class MemoryMembershipStore extends AdminMembershipStore {
  readonly name: string;
  private readonly rows = new Map<string, readonly MembershipRow[]>();

  constructor(opts: { readonly name?: string } = {}) {
    super();
    this.name = opts.name ?? 'memory';
  }

  async setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return latestPerSet([...new Set(memberKeys)].flatMap((k) => (this.rows.get(k) ?? []).filter((r) => isLive(r.expiresAt, at))));
  }

  async membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    return sorted(
      this.all()
        .filter((r) => r.setKey === setKey && isLive(r.expiresAt, at))
        .map((r) => r.memberKey),
    );
  }

  async rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]> {
    return [...new Set(memberKeys)].flatMap((k) => this.rows.get(k) ?? []).map(copy);
  }

  async allMembersOf(setKeys: readonly string[]): Promise<readonly string[]> {
    const wanted = new Set(setKeys);
    return sorted(
      this.all()
        .filter((r) => wanted.has(r.setKey))
        .map((r) => r.memberKey),
    );
  }

  async memberKeys(): Promise<readonly string[]> {
    return sorted(this.rows.keys());
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    const before = this.rows.get(memberKey);
    if (rows.length > 0) this.rows.set(memberKey, Object.freeze(rows.map((r) => copy({ ...r, memberKey }))));
    else this.rows.delete(memberKey);
    undo.onRollback(() => {
      if (before) this.rows.set(memberKey, before);
      else this.rows.delete(memberKey);
    });
  }

  private all(): MembershipRow[] {
    return [...this.rows.values()].flat();
  }
}
