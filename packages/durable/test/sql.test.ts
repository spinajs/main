import { expect } from 'chai';
import { onPrimary } from '../src/sql.js';

describe('onPrimary shim', () => {
  it('returns the query unchanged while the builder has no onPrimary()', () => {
    const query = { where: () => query };
    expect(onPrimary(query)).to.eq(query);
  });

  it('routes through onPrimary() once the builder has it', () => {
    const primary = { primary: true };
    expect(onPrimary({ onPrimary: () => primary })).to.eq(primary);
  });
});
