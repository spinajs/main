import 'mocha';
import { expect } from 'chai';

import { groupIndexColumns, referentialRule } from '../src/introspection.js';

describe('introspection helpers', () => {
  it('folds per-column rows into indexes sorted by name, columns in key order', () => {
    expect(
      groupIndexColumns([
        { name: 'ix_b', column: 'UserId', unique: false, primary: false },
        { name: 'ix_b', column: 'Views', unique: false, primary: false },
        { name: 'PRIMARY', column: 'Id', unique: true, primary: true },
      ]),
    ).to.deep.equal([
      { name: 'PRIMARY', columns: ['Id'], unique: true, primary: true },
      { name: 'ix_b', columns: ['UserId', 'Views'], unique: false, primary: false },
    ]);
  });

  it('spells referential actions the SQL-standard way', () => {
    expect(['NO_ACTION', 'no action', 'CASCADE', 'SET_NULL', null].map(referentialRule)).to.deep.equal(['NO ACTION', 'NO ACTION', 'CASCADE', 'SET NULL', undefined]);
  });
});
