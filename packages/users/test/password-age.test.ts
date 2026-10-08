import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DateTime } from 'luxon';
import { PasswordAgeSource } from '@spinajs/authn-local';

import { User, UserPasswordAgeSource, UsersPasswordSetAt_2026_10_04_00_00_00 } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA';

const sqlText = (at: Date) => DateTime.fromJSDate(at).toSQL({ includeOffset: false })!;

async function setPasswordSetAt(uuid: string, at: Date | null): Promise<void> {
  await User.query()
    .Driver.update()
    .in('users')
    .update({ PasswordSetAt: at ? sqlText(at) : null })
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

  describe('migration UsersPasswordSetAt_2026_10_04_00_00_00', () => {
    it('adds a nullable users.PasswordSetAt that the model reads as a DateTime', async () => {
      const { ref } = await seedUser({ login: 'age-model', password: HASH });
      const at = new Date('2026-09-01T10:00:00.000Z');
      await setPasswordSetAt(ref.id, at);

      expect(await columns()).to.include('PasswordSetAt');
      expect((await storedUser(ref.id)).PasswordSetAt.toMillis()).to.eq(at.getTime());
    });

    it('stamps the rows that hold a password with the migration time, and only those', async () => {
      const { ref: hash } = await seedUser({ login: 'age-backfill-hash', password: HASH });
      const { ref: none } = await seedUser({ login: 'age-backfill-none' });
      const { ref: expired } = await seedUser({ login: 'age-backfill-expired', password: '!expired' });
      const { ref: kept } = await seedUser({ login: 'age-backfill-kept', password: HASH });
      const earlier = new Date('2026-01-01T00:00:00.000Z');
      await setPasswordSetAt(kept.id, earlier);

      const before = Date.now();
      await new UsersPasswordSetAt_2026_10_04_00_00_00().up(User.query().Driver);

      expect((await storedUser(hash.id)).PasswordSetAt.toMillis()).to.be.within(before - 1000, Date.now() + 1000);
      expect((await storedUser(none.id)).PasswordSetAt).to.not.be.ok;
      expect((await storedUser(expired.id)).PasswordSetAt).to.not.be.ok;
      expect((await storedUser(kept.id)).PasswordSetAt.toMillis()).to.eq(earlier.getTime());
    });

    it('drops the column on down and adds it again on up', async () => {
      const migration = new UsersPasswordSetAt_2026_10_04_00_00_00();

      await migration.down(User.query().Driver);
      expect(await columns()).to.not.include('PasswordSetAt');

      await migration.up(User.query().Driver);
      expect(await columns()).to.include('PasswordSetAt');
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
