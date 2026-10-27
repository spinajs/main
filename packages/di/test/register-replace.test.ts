import 'mocha';
import { expect } from 'chai';
import { Container } from '../src/index.js';

class Base {}
class A extends Base {}
class B extends Base {}

describe('register with replace', () => {
  it('keeps the first position of a re-registered class by default', () => {
    const c = new Container();
    c.register(A).as(Base);
    c.register(B).as(Base);
    c.register(A).as(Base);
    expect(c.getRegisteredTypes(Base)).to.deep.equal([A, B]);
    expect(c.resolve(Base)).to.be.instanceOf(B);
  });

  it('moves a re-registered class to the last position with replace', () => {
    const c = new Container();
    c.register(A).as(Base);
    c.register(B).as(Base);
    c.register(A).as(Base, { replace: true });
    expect(c.getRegisteredTypes(Base)).to.deep.equal([B, A]);
    expect(c.resolve(Base)).to.be.instanceOf(A);
  });

  it('replace on a first registration behaves like a plain registration', () => {
    const c = new Container();
    c.register(A).as(Base, { replace: true });
    expect(c.getRegisteredTypes(Base)).to.deep.equal([A]);
  });
});
