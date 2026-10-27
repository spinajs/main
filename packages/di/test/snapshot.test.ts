import 'mocha';
import { expect } from 'chai';
import { AsyncService, Container, DI } from '../src/index.js';

class Base {}
class Impl extends Base {}
class Kept {}
class Svc extends AsyncService {
  public disposed = false;
  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe('container snapshot / restore', () => {
  it('restore drops registrations, values, singletons and listeners made after the snapshot and disposes the services', async () => {
    const c = new Container();
    c.register(Kept).asSelf();
    const kept = c.resolve(Kept);
    const before = c.snapshot();

    c.register(Impl).as(Base);
    c.register({ x: 1 }).asValue('__x__');
    const svc = await c.resolve(Svc);
    const listener = () => undefined;
    c.on('ev', listener);
    const child = c.child();

    await c.restore(before);

    expect(c.hasRegistered(Base)).to.be.false;
    expect(c.get('__x__')).to.be.undefined;
    expect(c.Cache.has(Svc)).to.be.false;
    expect(svc.disposed).to.be.true;
    expect(c.listenerCount('ev')).to.equal(0);
    expect(c.getCacheStats().childrenCount).to.equal(0);
    expect(c.getCacheStats().size).to.equal(before.cache.size);
    expect(child.getCacheStats().size).to.equal(1);
    expect(c.resolve(Kept)).to.equal(kept);
  });

  it('restore keeps a listener and a value that existed before the snapshot', async () => {
    const c = new Container();
    const listener = () => undefined;
    c.on('ev', listener);
    c.register({ a: 1 }).asValue('__a__');
    const before = c.snapshot();
    c.on('ev', () => undefined);
    await c.restore(before);
    expect(c.rawListeners('ev')).to.deep.equal([listener]);
    expect(c.get('__a__')).to.deep.equal({ a: 1 });
  });

  it('restore removes a second copy of a listener added after the snapshot', async () => {
    const c = new Container();
    const listener = () => undefined;
    c.on('ev', listener);
    const before = c.snapshot();
    c.on('ev', listener);
    await c.restore(before);
    expect(c.rawListeners('ev')).to.deep.equal([listener]);
  });

  it('restore puts back a registration list changed after the snapshot', async () => {
    const c = new Container();
    c.register(Impl).as(Base);
    const before = c.snapshot();
    c.unregister(Impl);
    c.register(Kept).as(Base);
    await c.restore(before);
    expect(c.getRegisteredTypes(Base)).to.deep.equal([Impl]);
  });

  it('a snapshot is not changed by later registrations', () => {
    const c = new Container();
    const before = c.snapshot();
    c.register(Impl).as(Base);
    expect(before.registry.has('Base')).to.be.false;
  });

  it('DI.snapshot / DI.restore act on the root container', async () => {
    const before = DI.snapshot();
    DI.register({ y: 1 }).asValue('__snapshot_root__');
    await DI.restore(before);
    expect(DI.get('__snapshot_root__')).to.be.undefined;
  });

  it('restore puts the entries of a value map back into the same Map', async () => {
    const c = new Container();
    const local = { name: 'local' };
    c.register(local).asMapValue('__file_provider_instance__', 'local');
    const map = c.get<Map<string, unknown>>('__file_provider_instance__');
    const before = c.snapshot();

    c.register({ name: 'temp' }).asMapValue('__file_provider_instance__', 'temp');
    c.register({ name: 'other local' }).asMapValue('__file_provider_instance__', 'local');
    await c.restore(before);

    const restored = c.get<Map<string, unknown>>('__file_provider_instance__');
    expect(restored).to.equal(map);
    expect([...restored.keys()]).to.deep.equal(['local']);
    expect(restored.get('local')).to.equal(local);
  });
});
