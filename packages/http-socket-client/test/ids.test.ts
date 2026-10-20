import 'mocha';
import { expect } from 'chai';
import { randomId } from '../src/ids.js';

describe('randomId', () => {
  it('uses crypto.randomUUID when the platform has it', () => {
    expect(randomId({ randomUUID: () => 'fixed-uuid' })).to.equal('fixed-uuid');
    expect(randomId()).to.match(/^[0-9a-f-]{36}$/);
  });

  it('falls back to unique Math.random ids without randomUUID', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId({})));
    expect(ids.size).to.equal(200);
    for (const id of ids) expect(id).to.match(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });
});
