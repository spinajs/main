import 'mocha';
import { expect } from 'chai';

import { DI } from '../src/index.js';
import { AsyncService } from '../src/index.js';

abstract class Missing {}
class Present {}
class Asynchronous extends AsyncService {}

describe('resolveOptional', () => {
  beforeEach(() => {
    DI.clear();
  });

  it('returns undefined for an unregistered class and leaves no implicit registration', () => {
    expect(DI.RootContainer.resolveOptional(Missing)).to.be.undefined;
    expect(DI.RootContainer.hasRegistered(Missing)).to.be.false;
  });

  it('resolves a class registered in the parent from a child container', () => {
    DI.register(Present).asSelf();
    const child = DI.child();
    expect(child.resolveOptional(Present)).to.be.instanceOf(Present);
  });

  it('resolves a registered AsyncService', async () => {
    DI.register(Asynchronous).asSelf();
    expect(await DI.RootContainer.resolveOptional(Asynchronous)).to.be.instanceOf(Asynchronous);
  });
});
