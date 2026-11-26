import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';

import { HistoryObserver } from '../src/observer.js';

describe('HistoryObserver', () => {
  it('is a WriteObserver that says it keeps history', () => {
    expect(DI.getRegisteredTypes(WriteObserver)).to.include(HistoryObserver);
    expect(new HistoryObserver().keepsHistory).to.equal(true);
  });
});
