import { expect } from 'chai';
import 'mocha';
import { answeredAsServerError, toProblem } from '@spinajs/http';
import { OptimisticLockError } from '@spinajs/orm';

describe('OptimisticLockError over http', () => {
  it('is a 409 problem body carrying model, key and expectedVersion', () => {
    const err = new OptimisticLockError('Invoice', 7, 3);

    const problem = toProblem(err, 409, { includeStack: false, includeFields: [], isProduction: true });

    expect(problem).to.include({ status: 409, model: 'Invoice', key: 7, expectedVersion: 3 });
    expect(answeredAsServerError(err)).to.eq(false);
  });
});
