import { expect } from 'chai';
import { OrmException } from '../src/exceptions.js';

describe('OrmException', () => {
  it('does not expose query, bindings, driver or inner when spread', () => {
    const e = new OrmException('boom', { Name: 'c', User: 'u', Host: 'h' }, 'select 1', [1], new Error('x'));
    const copy = { ...e };
    expect(copy).to.not.have.any.keys('query', 'bindings', 'driver', 'inner');
    expect(e.query).to.eq('select 1');
    expect(e.driver?.Name).to.eq('c');
  });
});
