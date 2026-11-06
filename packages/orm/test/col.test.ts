import 'mocha';
import { expect } from 'chai';

import { col } from '../src/typing.js';

describe('col()', () => {
  it('returns the column name unchanged', () => {
    expect(col('legacy_column')).to.equal('legacy_column');
  });
});
