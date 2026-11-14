import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { SelectQueryBuilder } from '../src/builders.js';
import { EXECUTION_LISTS } from '../src/builders/internal.js';
import type { OrmDriver } from '../src/driver.js';

describe('executionCopy', () => {
  it('copies only lists that a fresh select builder owns', () => {
    const builder = new SelectQueryBuilder(DI.RootContainer, {} as OrmDriver, undefined, undefined, false);

    for (const name of EXECUTION_LISTS) {
      expect(Object.hasOwn(builder, name), name).to.eq(true);
      expect(Reflect.get(builder, name), name).to.be.an('array');
    }
  });
});
