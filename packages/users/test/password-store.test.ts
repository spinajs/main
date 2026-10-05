import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { OrmDriver, RawQuery } from '@spinajs/orm';
import { PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { NO_PASSWORD, User, UserPasswordStore } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser } from './support/users-db.js';

const HASH_1 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$AbCdEfGh1';
const HASH_2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$AbCdEfGh2';

async function storedPassword(ref: IdentityRef): Promise<unknown> {
  const rows = (await User.query().Driver.select().from('users').columns(['Password']).where('Uuid', ref.id)) as { Password: unknown }[];
  return rows[0]?.Password;
}

async function storeRaw(ref: IdentityRef, value: string): Promise<void> {
  await User.query().Driver.update().in('users').update({ Password: value }).where('Uuid', ref.id);
}

/**
 * MySQL as `orm-mysql` would see it without CLIENT_FOUND_ROWS: an UPDATE reports the rows it CHANGED, so writing
 * the stored value again reports 0. One users row; conditions are read from the store's `where` calls.
 */
class ChangedRowsMysqlDriver {
  public readonly Options = { Driver: 'orm-driver-mysql' };
  public readonly Container = { resolve: () => ({ quote: (n: string) => `\`${n}\`` }) };
  public readonly conditions: string[] = [];
  public updates = 0;

  constructor(
    public readonly uuid: string,
    public stored: string,
  ) {}

  public update() {
    const conds: unknown[][] = [];
    let value: string | undefined;
    const b = {
      in: () => b,
      update: (v: { Password: string }) => ((value = v.Password), b),
      where: (...a: unknown[]) => (conds.push(a), b),
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        this.updates++;
        const matched = this.matches(conds);
        const changed = matched && value !== this.stored;
        if (matched) this.stored = value!;
        return Promise.resolve({ RowsAffected: changed ? 1 : 0 }).then(resolve, reject);
      },
    };
    return b;
  }

  public select() {
    const conds: unknown[][] = [];
    const b = {
      from: () => b,
      columns: () => b,
      where: (...a: unknown[]) => (conds.push(a), b),
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(this.matches(conds) ? [{ Uuid: this.uuid }] : []).then(resolve, reject),
    };
    return b;
  }

  private matches(conds: unknown[][]): boolean {
    return conds.every(([column, value]) => {
      if (column === 'Uuid') return value === this.uuid;
      const q = column as RawQuery;
      this.conditions.push(q.Query);
      return q.Query.includes('IS NULL') ? this.stored === '' || this.stored === NO_PASSWORD : q.Bindings[0] === this.stored;
    });
  }
}

describe('UserPasswordStore', function () {
  this.timeout(30000);

  let store: UserPasswordStore;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    store = new UserPasswordStore();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the registered PasswordCredentialStore', async () => {
    expect(await DI.resolve(PasswordCredentialStore)).to.be.instanceOf(UserPasswordStore);
  });

  describe('get', () => {
    it('reads a stored hash and a marker verbatim', async () => {
      const { ref } = await seedUser({ login: 'get-hash', password: HASH_1 });
      const { ref: expired } = await seedUser({ login: 'get-expired', password: '!expired' });

      expect(await store.get(ref)).to.eq(HASH_1);
      expect(await store.get(expired)).to.eq('!expired');
    });

    it("reads NO_PASSWORD and '' as no password", async () => {
      const { ref } = await seedUser({ login: 'get-none' });
      const { ref: empty } = await seedUser({ login: 'get-empty' });
      await storeRaw(empty, '');

      expect(await store.get(ref)).to.eq(null);
      expect(await store.get(empty)).to.eq(null);
    });

    it('answers null for an unknown user and a non-user identity', async () => {
      const { ref } = await seedUser({ login: 'get-typed', password: HASH_1 });

      expect(await store.get({ type: 'user', id: '00000000-0000-4000-8000-000000000000' })).to.eq(null);
      expect(await store.get({ type: 'service', id: ref.id })).to.eq(null);
    });
  });

  describe('set (RFC N3-1)', () => {
    it('without expected writes and answers true, even when the value does not change', async () => {
      const { ref } = await seedUser({ login: 'set-plain' });

      expect(await store.set(ref, HASH_1)).to.eq(true);
      expect(await store.set(ref, HASH_1)).to.eq(true);
      expect(await storedPassword(ref)).to.eq(HASH_1);
    });

    it('with a string writes only over exactly that value', async () => {
      const { ref } = await seedUser({ login: 'set-cas', password: HASH_1 });

      expect(await store.set(ref, HASH_2, HASH_1.toUpperCase())).to.eq(false);
      expect(await store.set(ref, HASH_2, `${HASH_1} `)).to.eq(false);
      expect(await storedPassword(ref)).to.eq(HASH_1);
      expect(await store.set(ref, HASH_2, HASH_1)).to.eq(true);
      expect(await storedPassword(ref)).to.eq(HASH_2);
    });

    it("with null writes over NO_PASSWORD and '', never over a password or a marker", async () => {
      const { ref: none } = await seedUser({ login: 'set-null-none' });
      const { ref: empty } = await seedUser({ login: 'set-null-empty' });
      const { ref: held } = await seedUser({ login: 'set-null-held', password: HASH_1 });
      const { ref: expired } = await seedUser({ login: 'set-null-expired', password: '!expired' });
      await storeRaw(empty, '');

      expect(await store.set(none, HASH_2, null)).to.eq(true);
      expect(await store.set(empty, HASH_2, null)).to.eq(true);
      expect(await store.set(held, HASH_2, null)).to.eq(false);
      expect(await store.set(expired, HASH_2, null)).to.eq(false);
      expect(await storedPassword(held)).to.eq(HASH_1);
      expect(await storedPassword(expired)).to.eq('!expired');
    });

    it("keeps undefined and null apart, and never matches the no-password values given as strings", async () => {
      const { ref } = await seedUser({ login: 'set-apart' });

      expect(await store.set(ref, HASH_1, NO_PASSWORD)).to.eq(false);
      expect(await store.set(ref, HASH_1, '')).to.eq(false);
      expect(await storedPassword(ref)).to.eq(NO_PASSWORD);
      expect(await store.set(ref, HASH_1, undefined)).to.eq(true);
    });

    it('with expected equal to the new hash answers whether the stored value is that hash', async () => {
      const { ref } = await seedUser({ login: 'set-same', password: HASH_1 });

      expect(await store.set(ref, HASH_1, HASH_1)).to.eq(true);
      expect(await store.set(ref, HASH_2, HASH_2)).to.eq(false);
      expect(await storedPassword(ref)).to.eq(HASH_1);
    });

    it('answers false for a conditional write to an unknown user or a non-user identity', async () => {
      const { ref } = await seedUser({ login: 'set-unknown', password: HASH_1 });

      expect(await store.set({ type: 'user', id: '00000000-0000-4000-8000-000000000000' }, HASH_2, HASH_1)).to.eq(false);
      expect(await store.set({ type: 'service', id: ref.id }, HASH_2, HASH_1)).to.eq(false);
      expect(await storedPassword(ref)).to.eq(HASH_1);
    });

    it('lets exactly one of eight parallel conditional writers win', async () => {
      const { ref } = await seedUser({ login: 'set-race', password: HASH_1 });
      const hashes = Array.from({ length: 8 }, (_, i) => `${HASH_2}-${i}`);

      const wrote = await Promise.all(hashes.map((h) => store.set(ref, h, HASH_1)));

      expect(wrote.filter(Boolean)).to.have.lengthOf(1);
      expect(await storedPassword(ref)).to.eq(hashes[wrote.indexOf(true)]);
    });

    it('rethrows a driver error without the hash or the statement', async () => {
      const { ref } = await seedUser({ login: 'set-error', password: HASH_1 });
      const driver = User.query().Driver;
      sinon.stub(driver, 'update').throws(new Error(`SQLITE_ERROR: UPDATE users SET Password = '${HASH_2}' WHERE Uuid = '${ref.id}'`));

      const err = await store.set(ref, HASH_2).then(
        () => undefined,
        (e: unknown) => e as Error,
      );

      expect(err).to.be.instanceOf(UnexpectedServerError);
      expect(err!.message).to.contain(ref.id);
      const everything = JSON.stringify({ message: err!.message, stack: err!.stack, props: { ...err } });
      expect(everything).to.not.contain(HASH_2);
      expect(everything).to.not.contain('UPDATE');
    });
  });

  describe('on MySQL without CLIENT_FOUND_ROWS (a driver that counts changed rows)', () => {
    const uuid = '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10';

    it('the fake reports 0 rows for an UPDATE that writes the stored value again', async () => {
      const driver = new ChangedRowsMysqlDriver(uuid, HASH_1);

      expect(await driver.update().in().update({ Password: HASH_1 }).where('Uuid', uuid)).to.deep.eq({ RowsAffected: 0 });
    });

    it('a conditional write of the stored value answers from the stored value and writes nothing', async () => {
      const driver = new ChangedRowsMysqlDriver(uuid, HASH_1);
      const mysql = new UserPasswordStore({ driver: driver as unknown as OrmDriver });

      expect(await mysql.set({ type: 'user', id: uuid }, HASH_1, HASH_1)).to.eq(true);
      expect(await mysql.set({ type: 'user', id: uuid }, HASH_2, HASH_2)).to.eq(false);
      expect(driver.updates).to.eq(0);
    });

    it('a conditional write of a new value answers true once and compares binary', async () => {
      const driver = new ChangedRowsMysqlDriver(uuid, HASH_1);
      const mysql = new UserPasswordStore({ driver: driver as unknown as OrmDriver });

      expect(await mysql.set({ type: 'user', id: uuid }, HASH_2, HASH_1)).to.eq(true);
      expect(await mysql.set({ type: 'user', id: uuid }, HASH_2, HASH_1)).to.eq(false);
      expect(driver.stored).to.eq(HASH_2);
      expect(driver.conditions[0]).to.eq('`Password` = CAST(? AS BINARY)');
    });
  });
});
