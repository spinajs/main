import 'mocha';
import { expect } from 'chai';
import { AsyncService, Container } from '../src/index.js';

class S {}
class Base {}
class Impl extends Base {}
class Svc extends AsyncService {
  public disposed = false;
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe('child({ isolateSingletons: true })', () => {
  it('a root-registered singleton resolved through an isolating child is owned by the child', () => {
    const root = new Container();
    root.register(S).asSelf();
    const c1 = root.child({ isolateSingletons: true });
    const c2 = root.child({ isolateSingletons: true });

    const s1 = c1.resolve(S);
    const s2 = c2.resolve(S);

    expect(s1).to.be.instanceOf(S);
    expect(s1).to.not.equal(s2);
    expect(root.Cache.has(S)).to.be.false;
    expect(c1.Cache.has(S)).to.be.true;
    expect(c2.Cache.has(S)).to.be.true;
  });

  it('an instance already cached in root is not reused by an isolating child', () => {
    const root = new Container();
    root.register(S).asSelf();
    const inRoot = root.resolve(S);
    const child = root.child({ isolateSingletons: true });
    expect(child.resolve(S)).to.not.equal(inRoot);
    expect(child.resolve(S)).to.equal(child.resolve(S));
  });

  it('a plain child still shares the root singleton', () => {
    const root = new Container();
    root.register(S).asSelf();
    const child = root.child();
    expect(child.resolve(S)).to.equal(root.resolve(S));
    expect(root.Cache.has(S)).to.be.true;
  });

  it('a plain child of an isolating child sends singletons to the isolating child, not to root', () => {
    const root = new Container();
    root.register(S).asSelf();
    const isolating = root.child({ isolateSingletons: true });
    const grandchild = isolating.child();

    const s = grandchild.resolve(S);
    expect(root.Cache.has(S)).to.be.false;
    expect(isolating.Cache.has(S)).to.be.true;
    expect(isolating.resolve(S)).to.equal(s);
  });

  it('Array.ofType in an isolating child creates child-owned instances', () => {
    const root = new Container();
    root.register(Impl).as(Base);
    const child = root.child({ isolateSingletons: true });
    const list = child.resolve(Array.ofType(Base));
    expect(list).to.have.length(1);
    expect(root.Cache.has(Base)).to.be.false;
    expect(child.Cache.has(Base)).to.be.true;
  });

  it('registrations are still inherited from the root', () => {
    const root = new Container();
    root.register(Impl).as(Base);
    const child = root.child({ isolateSingletons: true });
    expect(child.resolve(Base)).to.be.instanceOf(Impl);
    expect(child.Registry.ownsRegistration('Base')).to.be.false;
  });

  it('dispose of an isolating child disposes the services it owns and leaves root untouched', async () => {
    const root = new Container();
    root.register(Svc).asSelf();
    const child = root.child({ isolateSingletons: true });
    const svc = await child.resolve(Svc);
    await child.dispose();
    expect(svc.disposed).to.be.true;
    expect(child.Cache.has(Svc)).to.be.false;
    expect(root.Cache.has(Svc)).to.be.false;
    expect(root.getCacheStats().childrenCount).to.equal(0);
  });
});
