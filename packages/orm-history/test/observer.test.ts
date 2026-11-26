import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Hidden, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest } from '@spinajs/orm';

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
  });
});
