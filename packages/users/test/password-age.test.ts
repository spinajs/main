import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { PasswordAgeSource } from '@spinajs/authn-local';

import { User, UserPasswordAgeSource } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA';

async function setPasswordSetAt(uuid: string, at: Date | null): Promise<void> {
  await User.query()
    .Driver.update()
    .in('users')
    .update({ PasswordSetAt: at })
    .where('Uuid', uuid);
}

async function columns(): Promise<string[]> {
  return (await User.query().Driver.tableInfo('users')).map((c) => c.Name);
}

describe('password age (PasswordSetAt, UserPasswordAgeSource)', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('users.PasswordSetAt', () => {
    it('is a nullable column that the model reads as a DateTime', async () => {
      const { ref } = await seedUser({ login: 'age-model', password: HASH });
      expect(await columns()).to.include('PasswordSetAt');
      expect((await storedUser(ref.id)).PasswordSetAt).to.not.be.ok;

      const at = new Date('2026-09-01T10:00:00.000Z');
      await setPasswordSetAt(ref.id, at);
      expect((await storedUser(ref.id)).PasswordSetAt.toMillis()).to.eq(at.getTime());
    });
  });

  describe('UserPasswordAgeSource', () => {
    it('is the registered PasswordAgeSource', async () => {
      expect(DI.check(PasswordAgeSource)).to.eq(true);
      expect(await DI.resolve(PasswordAgeSource)).to.be.instanceOf(UserPasswordAgeSource);
    });

    it('lists users holding a password set before the cutoff or at an unknown time, not deleted, as user refs', async () => {
      const cutoff = new Date('2026-09-01T00:00:00.000Z');
      const old = await seedUser({ login: 'age-old', password: HASH });
      const fresh = await seedUser({ login: 'age-fresh', password: HASH });
      const atCutoff = await seedUser({ login: 'age-at-cutoff', password: HASH });
      const deleted = await seedUser({ login: 'age-deleted', password: HASH });
      const invited = await seedUser({ login: 'age-invited' });
      const expired = await seedUser({ login: 'age-expired', password: '!expired' });
      const never = await seedUser({ login: 'age-never', password: HASH });
      const invitedNever = await seedUser({ login: 'age-invited-never' });

      await setPasswordSetAt(old.ref.id, new Date(cutoff.getTime() - 86_400_000));
      await setPasswordSetAt(fresh.ref.id, new Date(cutoff.getTime() + 1000));
      await setPasswordSetAt(atCutoff.ref.id, cutoff);
      await setPasswordSetAt(deleted.ref.id, new Date(cutoff.getTime() - 86_400_000));
      await deleted.user.destroy();
      await setPasswordSetAt(invited.ref.id, new Date(cutoff.getTime() - 86_400_000));
      await setPasswordSetAt(expired.ref.id, new Date(cutoff.getTime() - 86_400_000));
      await setPasswordSetAt(never.ref.id, null);
      await setPasswordSetAt(invitedNever.ref.id, null);

      const listed = await new UserPasswordAgeSource().passwordsSetBefore(cutoff);
      const seeded = listed.filter((r) => [old, fresh, atCutoff, deleted, invited, expired, never, invitedNever].some((s) => s.ref.id === r.id));

      // A lost PasswordSetAt write leaves NULL beside a real password: unknown age counts as old.
      expect(seeded.map((r) => r.id).sort()).to.deep.eq([old.ref.id, never.ref.id].sort());
      expect(seeded.every((r) => r.type === 'user')).to.eq(true);
    });
  });
});
