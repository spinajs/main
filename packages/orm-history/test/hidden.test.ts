import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Hidden, Orm } from '@spinajs/orm';
import { historySpecOf, registerHistory } from '../src/index.js';
import type { HistoryOptions } from '../src/index.js';
import { HistoryDb, applyDecorator } from './support/db.js';
import type { ColumnType, Dialect, ModelSpec, TrackedClass } from './support/db.js';

const expect = chai.expect;

type Data = Record<string, unknown>;

const COLUMNS: Readonly<Record<string, ColumnType>> = { name: 'TEXT', twoFactorSecret: 'TEXT' };
const hideSecret: ModelSpec['decorate'] = (_, p) => applyDecorator(Hidden(), p, 'twoFactorSecret');

describe('history masks a @Hidden() column whichever model of the table declares it', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of HistoryDb.dialects()) {
    describe(dialect, () => {
      const elsewhere: Dialect = dialect === 'sqlite' ? 'pglite' : 'sqlite';
      const recorded = async (): Promise<Data[]> => (await db.rows('orm_history', dialect)).map((r) => JSON.parse(String(r.data)) as Data);
      const rows = async (): Promise<string> => JSON.stringify(await db.rows('orm_history', dialect));
      const user = (options?: HistoryOptions): Promise<TrackedClass> => db.define({ name: 'User', table: 'users', columns: COLUMNS, decorate: (c) => registerHistory(c, options) }, dialect);
      const adminUser = (base: TrackedClass): Promise<TrackedClass> => db.define({ name: 'AdminUser', table: 'users', base, columns: {}, decorate: hideSecret }, dialect);

      beforeEach(async () => {
        await db.migrateHistory(dialect);
      });

      afterEach(async () => {
        db.config.set('audit.data.rules', []);
        await db.clear();
      });

      it('masks a column only a subclass hides in writes built on the base and on the subclass', async () => {
        const User = await user();
        const AdminUser = await adminUser(User);
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });
        await User.update({ name: 'b', twoFactorSecret: 'secret-2' }).where('id', 'u1');
        await AdminUser.update({ name: 'c', twoFactorSecret: 'secret-3' }).where('id', 'u1');
        await User.destroy('u1');

        expect(await recorded()).to.deep.eq([
          { after: { id: 'u1', name: 'a' } },
          { before: { name: 'a' }, after: { id: 'u1', name: 'b' }, changed: ['name', 'twoFactorSecret'] },
          { before: { name: 'b' }, after: { id: 'u1', name: 'c' }, changed: ['name', 'twoFactorSecret'] },
          { before: { id: 'u1', name: 'c' } },
        ]);
        expect(await rows()).to.not.contain('secret-');
      });

      it('masks a column an unrelated class on the same table hides', async () => {
        const Member = await db.define({ name: 'Member', table: 'members', columns: COLUMNS, decorate: (c) => registerHistory(c) }, dialect);
        const Profile = await db.define(
          {
            name: 'Profile',
            table: 'members',
            existingTable: true,
            columns: {},
            decorate: (c, p) => {
              registerHistory(c);
              hideSecret(c, p);
            },
          },
          dialect,
        );
        await Member.insert({ id: 'm1', name: 'a', twoFactorSecret: 'secret-1' });
        await Member.update({ twoFactorSecret: 'secret-2' }).where('id', 'm1');
        await Profile.update({ twoFactorSecret: 'secret-3' }).where('id', 'm1');

        const masked = { before: {}, after: { id: 'm1', name: 'a' }, changed: ['twoFactorSecret'] };
        expect(await recorded()).to.deep.eq([{ after: { id: 'm1', name: 'a' } }, masked, masked]);
        expect(await rows()).to.not.contain('secret-');
      });

      it('does not mask a column that a class on a table of the same name on another connection hides', async () => {
        const User = await user();
        await db.define({ name: 'RemoteUser', table: 'users', columns: COLUMNS, decorate: hideSecret }, elsewhere);
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });

        expect(await recorded()).to.deep.eq([{ after: { id: 'u1', name: 'a', twoFactorSecret: 'secret-1' } }]);
      });

      // `default` names the sqlite connection only.
      for (const connection of dialect === 'sqlite' ? [HistoryDb.aliasOf(dialect), 'default'] : [HistoryDb.aliasOf(dialect)]) {
        it(`masks a column a class on the table hides that declares the connection as ${connection}`, async () => {
          const Member = await db.define({ name: 'Member', table: 'members', columns: COLUMNS, decorate: (c) => registerHistory(c) }, dialect);
          await db.define({ name: 'Profile', table: 'members', existingTable: true, connection, columns: {}, decorate: hideSecret }, dialect);
          await Member.insert({ id: 'm1', name: 'a', twoFactorSecret: 'secret-1' });

          expect(await recorded()).to.deep.eq([{ after: { id: 'm1', name: 'a' } }]);
        });
      }

      it('masks a column another class hides in a spec first asked for before the Orm resolved', async () => {
        const User = await user();
        await adminUser(User);
        const orm = DI.get(Orm);
        DI.RootContainer.Cache.remove(Orm);
        try {
          expect(DI.get(Orm)).to.eq(undefined);
          expect(historySpecOf(User)?.masked).to.deep.eq(new Set());
        } finally {
          DI.RootContainer.Cache.add(Orm, orm);
        }
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });

        expect(await recorded()).to.deep.eq([{ after: { id: 'u1', name: 'a' } }]);
      });

      it("stores a column a subclass hides with hidden: 'record' on the tracked base", async () => {
        const User = await user({ hidden: 'record' });
        await adminUser(User);
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });

        expect(await recorded()).to.deep.eq([{ after: { id: 'u1', name: 'a', twoFactorSecret: 'secret-1' } }]);
      });

      it('records a column a subclass hides when the tracked base lists it in columns', async () => {
        const User = await user({ columns: ['twoFactorSecret'] });
        await adminUser(User);
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });
        await User.update({ twoFactorSecret: 'secret-2' }).where('id', 'u1');

        expect(await recorded()).to.deep.eq([
          { after: { id: 'u1', twoFactorSecret: 'secret-1' } },
          { before: { twoFactorSecret: 'secret-1' }, after: { id: 'u1', twoFactorSecret: 'secret-2' }, changed: ['twoFactorSecret'] },
        ]);
      });

      it('masks a column a subclass hides in writes built on a base that audit.data.rules tracks', async () => {
        db.config.set('audit.data.rules', [{ models: ['User'] }]);
        const User = await db.define({ name: 'User', table: 'users', columns: COLUMNS, decorate: () => undefined }, dialect);
        await adminUser(User);
        await User.insert({ id: 'u1', name: 'a', twoFactorSecret: 'secret-1' });
        await User.update({ twoFactorSecret: 'secret-2' }).where('id', 'u1');

        expect(await recorded()).to.deep.eq([{ after: { id: 'u1', name: 'a' } }, { before: {}, after: { id: 'u1', name: 'a' }, changed: ['twoFactorSecret'] }]);
        expect(await rows()).to.not.contain('secret-');
      });
    });
  }
});
