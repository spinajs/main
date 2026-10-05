import { Injectable } from '@spinajs/di';
import { IdentityStore } from '@spinajs/authn/contracts';
import type { IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';

import { USER_COMMON_METADATA, User } from '../models/User.js';
import { quoted, raw, usersDriver } from './sql.js';

const UNKNOWN: IdentityStatus = Object.freeze({ exists: false, active: false, banned: false, deleted: false, invitePending: false });

/** authn-local's `normalizeLogin`, which keys the login throttle. */
const normalized = (login: string) => login.normalize('NFKC').trim().toLowerCase();

/**
 * Users as authn identities (`user:<Uuid>`). Every lookup uses the base `User` and includes soft-deleted rows, so
 * `status` can answer `deleted`. No `provision`: JIT provisioning is off (design §22.5) and users does not offer it.
 */
@Injectable(IdentityStore)
export class UserIdentityStore extends IdentityStore {
  /**
   * By email or login name, never by Id or Uuid. Case and the normalisation authn-local's throttle applies do not
   * matter, so the throttle and the lookup agree on the account. A value equal to the stored one as typed wins;
   * otherwise exactly one account must match, else null.
   */
  public async findByLogin(login: string): Promise<IdentityRef | null> {
    if (typeof login !== 'string' || login.trim() === '') {
      return null;
    }

    const typed = login.trim();
    const wanted = [...new Set([typed.toLowerCase(), normalized(login)])];
    const driver = usersDriver();
    const marks = wanted.map(() => '?').join(', ');
    const email = quoted(driver, 'Email');
    const name = quoted(driver, 'Login');

    const rows = await User.query()
      .withDeleted()
      .where(raw({ sql: `(LOWER(${email}) IN (${marks}) OR LOWER(${name}) IN (${marks}))`, bindings: [...wanted, ...wanted] }));

    const ranked = rows.map((u) => ({ u, rank: u.Email === typed ? 0 : u.Login === typed ? 1 : 2 }));
    const best = Math.min(...ranked.map((r) => r.rank));
    const winners = ranked.filter((r) => r.rank === best);

    return winners.length === 1 ? { type: 'user', id: winners[0].u.Uuid } : null;
  }

  public async status(id: IdentityRef): Promise<IdentityStatus> {
    const u = await this.find(id, true);
    if (!u) {
      return UNKNOWN;
    }

    return {
      exists: true,
      active: Boolean(u.IsActive),
      banned: u.IsBanned,
      deleted: Boolean(u.DeletedAt),
      invitePending: u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] === true,
    };
  }

  public async display(id: IdentityRef): Promise<{ email?: string; name?: string }> {
    const u = await this.find(id, false);
    return u ? { email: u.Email, name: u.Login } : {};
  }

  protected async find(id: IdentityRef, withMetadata: boolean): Promise<User | undefined> {
    if (id?.type !== 'user' || typeof id.id !== 'string') {
      return undefined;
    }

    const query = User.query().withDeleted().where('Uuid', id.id);
    return (await (withMetadata ? query.populate('Metadata') : query).first()) ?? undefined;
  }
}
