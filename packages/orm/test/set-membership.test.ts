/* eslint-disable prettier/prettier */
import * as chai from 'chai';
import 'mocha';

import { escapeLikeValue, SET_DELIMITER } from '../src/statements.js';

const expect = chai.expect;

/**
 * Rules shared by every driver's set-membership statement.
 *
 * They live on the abstract statement rather than in each dialect because they are
 * properties of the STORAGE FORMAT — a delimited column — not of any SQL flavour. Each
 * driver then spells the search its own way ( `FIND_IN_SET`, `instr`, `CHARINDEX`, or
 * the portable LIKE form ).
 */
describe('set membership value rules', () => {
  it('escapes LIKE metacharacters so a role named admin_1 does not match adminX1', () => {
    expect(escapeLikeValue('admin_1')).to.eq('admin~_1');
    expect(escapeLikeValue('100%')).to.eq('100~%');
    expect(escapeLikeValue('plain')).to.eq('plain');
  });

  it('escapes the escape character itself', () => {
    expect(escapeLikeValue('a~b')).to.eq('a~~b');
  });

  it('agrees with the delimiter the Set converter joins on', () => {
    expect(SET_DELIMITER).to.eq(',');
  });
});
