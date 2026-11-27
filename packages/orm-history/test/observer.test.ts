import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Hidden, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, WriteStatement } from '@spinajs/orm';

import { registerHistory } from '../src/index.js';
import type { HistoryOptions } from '../src/index.js';
import { HistoryObserver } from '../src/observer.js';
import { HistoryDb, applyDecorator } from './support/db.js';

describe('HistoryObserver', () => {
  it('is a WriteObserver that says it keeps history', () => {
    expect(DI.getRegisteredTypes(WriteObserver)).to.include(HistoryObserver);
    expect(new HistoryObserver().keepsHistory).to.equal(true);
  });

  describe('names the columns it reads but does not record', function () {
    this.timeout(60000);
    let db: HistoryDb;

    before(async () => {
      db = await HistoryDb.open();
    });

    after(async () => {
      await db?.close();
    });

    afterEach(async () => {
      await db.clear();
    });

    const interestOf = async (options: HistoryOptions, hideSecret = false): Promise<CaptureInterest | undefined> => {
      const User = await db.define(
        {
          name: 'User',
          table: 'users',
          columns: { name: 'TEXT', secret: 'TEXT' },
          decorate: (c, p) => {
            registerHistory(c, options);
            if (hideSecret) applyDecorator(Hidden(), p, 'secret');
          },
        },
        'sqlite',
      );
      return DI.resolve(HistoryObserver).interest({ kind: 'delete', model: User, query: User.destroy('u1') });
    };

    it('a column exclude leaves out', async () => {
      expect(await interestOf({ exclude: ['secret'] })).to.deep.equal({ columns: '*', transactional: true, unrecorded: ['secret'] });
    });

    it("a @Hidden() column it masks, and none with hidden: 'record'", async () => {
      expect(await interestOf({}, true)).to.deep.equal({ columns: '*', transactional: true, unrecorded: ['secret'] });
      await db.clear();
      expect(await interestOf({ hidden: 'record' }, true)).to.deep.equal({ columns: '*', transactional: true, unrecorded: [] });
    });

    it('none in full mode or in column mode, whose columns are the ones it records', async () => {
      expect(await interestOf({})).to.deep.equal({ columns: '*', transactional: true, unrecorded: [] });
      await db.clear();
      expect(await interestOf({ columns: ['name'] })).to.deep.equal({ columns: ['name'], transactional: true, unrecorded: [] });
    });

    // A package that refuses unrecorded writes counts an interest without unrecorded as recording nothing.
    it('states unrecorded for an insert, an update and a delete in full mode, also of a model registered after its first write', async () => {
      const User = await db.define({ name: 'User', table: 'users', columns: { name: 'TEXT', secret: 'TEXT' }, decorate: () => undefined }, 'sqlite');
      const writes: WriteStatement[] = [
        { kind: 'insert', model: User, query: User.insert({ id: 'u1', name: 'a' }) },
        { kind: 'update', model: User, query: User.update({ name: 'b' }) },
        { kind: 'delete', model: User, query: User.destroy('u1') },
      ];
      const observer = DI.resolve(HistoryObserver);
      expect(writes.map((w) => observer.interest(w))).to.deep.equal([undefined, undefined, undefined]);
      registerHistory(User, {});
      const full = { columns: '*', transactional: true, unrecorded: [] };
      expect(writes.map((w) => observer.interest(w))).to.deep.equal([full, full, full]);
    });
  });
});
