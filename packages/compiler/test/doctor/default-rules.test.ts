import 'mocha';
import { expect } from 'chai';
import { DEFAULT_RULES } from '../../src/doctor/index.js';

describe('DEFAULT_RULES', () => {
  it('lists the rules in table order with unique codes', () => {
    const codes = DEFAULT_RULES.map((r) => r.code);
    expect(codes).to.deep.equal(['DI001', 'DI002', 'DI003', 'HTTP001', 'HTTP002', 'HTTP003', 'HTTP004', 'HTTP005', 'CFG001', 'CFG002', 'CFG003', 'BLD001', 'ORM001', 'SCH003']);
    expect(new Set(codes).size).to.equal(codes.length);
    for (const r of DEFAULT_RULES) expect(r.describe, r.code).to.be.a('string').and.not.empty;
  });
});
