/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { BelongsToRelationResultTransformMiddleware } from '../src/middlewares.js';

describe('BelongsToRelationResultTransformMiddleware.afterQuery', () => {
  it('returns new row objects and leaves the input rows untouched', () => {
    const row = { Id: 1, '$Owner$.Name': 'bob' };
    const input = [row];

    const out = new BelongsToRelationResultTransformMiddleware().afterQuery(input);

    expect(out[0]).to.not.equal(row);
    expect(row).to.deep.equal({ Id: 1, '$Owner$.Name': 'bob' });
  });

  it('still nests the $-prefixed keys and drops them from the result', () => {
    const out = new BelongsToRelationResultTransformMiddleware().afterQuery([{ Id: 1, '$Owner$.Name': 'bob' }]);

    expect(out[0].Id).to.equal(1);
    expect(out[0].Owner).to.deep.equal({ Name: 'bob' });
    expect(out[0]).to.not.have.property('$Owner$.Name');
  });

  it('handles a row with no $-prefixed keys', () => {
    const out = new BelongsToRelationResultTransformMiddleware().afterQuery([{ Id: 1, Bar: 'x' }]);

    expect(out[0]).to.deep.equal({ Id: 1, Bar: 'x' });
  });

  it('returns one output row per input row', () => {
    const out = new BelongsToRelationResultTransformMiddleware().afterQuery([{ Id: 1 }, { Id: 2 }, { Id: 3 }]);

    expect(out.length).to.equal(3);
  });
});
