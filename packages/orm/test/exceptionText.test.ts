import { expect } from 'chai';
import 'mocha';
import { OrmException, OrmNotFoundException } from '../src/exceptions.js';

describe('OrmException text', () => {
  it('stringifies with its name and message', () => {
    expect(String(new OrmException('boom'))).to.equal('OrmException: boom');
    expect(`${new OrmNotFoundException('no row')}`).to.equal('OrmNotFoundException: no row');
  });

  it('keeps the connection text it builds when a driver is given', () => {
    const text = String(new OrmException('failed', { Name: 'main', User: 'u', Host: 'h' }));
    expect(text).to.equal('OrmException: Error during execution statement on connection main at u@h, inner exception: none, message: failed');
  });
});
