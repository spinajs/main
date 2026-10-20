import 'mocha';
import { expect } from 'chai';

import { DI } from '../src/index.js';

class Base {}
class Override extends Base {}
class Other extends Base {}

describe('unregister', () => {
  beforeEach(() => {
    DI.clear();
  });

  it('removing the only override restores the default resolution of the base', () => {
    DI.register(Override).as(Base);
    expect(DI.resolve(Base)).to.be.instanceOf(Override);

    DI.unregister(Override);
    DI.uncache(Base);

    expect(DI.checkType(Base, Override)).to.eq(false);
    expect(DI.check(Base)).to.eq(false);
    const resolved = DI.resolve(Base);
    expect(resolved).to.be.instanceOf(Base);
    expect(resolved).to.not.be.instanceOf(Override);
  });

  it('removing one of two overrides keeps the other', () => {
    DI.register(Override).as(Base);
    DI.register(Other).as(Base);

    DI.unregister(Other);
    DI.uncache(Base);

    expect(DI.getRegisteredTypes(Base)).to.deep.eq([Override]);
    expect(DI.resolve(Base)).to.be.instanceOf(Override);
  });

  it('a name key left without entries no longer counts as registered', () => {
    DI.register(Override).as('named-service');
    expect(DI.check('named-service')).to.eq(true);

    DI.unregister(Override);

    expect(DI.check('named-service')).to.eq(false);
    expect(DI.resolve('named-service')).to.eq(null);
  });

  it('a list emptied by unregister resolves no element', () => {
    DI.register(Override).as(Base);
    DI.unregister(Override);

    expect(DI.resolve(Array.ofType(Base))).to.deep.eq([]);
  });

  it('a child that unregisters its last entry falls back to the parent, as if it never registered', () => {
    DI.register(Override).as(Base);
    const child = DI.child();
    child.register(Other).as(Base);
    expect(child.resolve(Base)).to.be.instanceOf(Other);

    child.unregister(Other);
    child.uncache(Base);

    expect(child.hasRegistered(Base, false)).to.eq(false);
    expect(child.resolve(Base)).to.be.instanceOf(Override);
  });
});
