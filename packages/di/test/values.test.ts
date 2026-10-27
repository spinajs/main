import 'mocha';
import { expect } from 'chai';
import { Container, SyncService } from '../src/index.js';

class Cached {}
class Shape {}
class Square extends Shape {}
class Closable extends SyncService {
  public disposed = 0;
  public dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

describe('values registered with asValue / asMapValue', () => {
  it('asValue survives clearCache and is dropped by clearRegistry', () => {
    const c = new Container();
    c.register({ a: 1 }).asValue('__v__');
    c.clearCache();
    expect(c.get('__v__')).to.deep.equal({ a: 1 });
    c.clearRegistry();
    expect(c.get('__v__')).to.be.undefined;
  });

  it('asValue without override appends, with override replaces', () => {
    const c = new Container();
    const first = { n: 1 };
    const second = { n: 2 };
    c.register(first).asValue('__v__');
    c.register(second).asValue('__v__');
    expect(c.get(Array.ofType('__v__'))).to.deep.equal([first, second]);
    c.register({ n: 3 }).asValue('__v__', true);
    expect(c.get(Array.ofType('__v__'))).to.deep.equal([{ n: 3 }]);
  });

  it('asValue with override replaces an instance already cached under that key', () => {
    const c = new Container();
    c.register(Cached).asSelf();
    c.resolve(Cached);
    const value = new Cached();
    c.register(value).asValue('Cached', true);
    expect(c.get(Cached)).to.equal(value);
    expect(c.resolve(Cached)).to.equal(value);
  });

  it('asMapValue survives clearCache', () => {
    const c = new Container();
    const converter = () => 1;
    c.register(converter).asMapValue('__map__', 'int');
    c.clearCache();
    expect(c.get<Map<string, unknown>>('__map__').get('int')).to.equal(converter);
  });

  it('uncache removes a value', () => {
    const c = new Container();
    c.register({ a: 1 }).asValue('__v__');
    c.uncache('__v__');
    expect(c.get('__v__')).to.be.undefined;
    expect(c.isResolved('__v__')).to.be.false;
  });

  it('a child reads a parent value and the parent does not read a child value', () => {
    const root = new Container();
    const child = root.child();
    root.register({ a: 1 }).asValue('__root__');
    child.register({ b: 2 }).asValue('__child__');
    expect(child.get('__root__')).to.deep.equal({ a: 1 });
    expect(root.get('__child__')).to.be.undefined;
  });

  it('Array.ofType over a value key resolves the values', () => {
    const c = new Container();
    c.register({ a: 1 }).asValue('__list__');
    c.clearCache();
    expect(c.resolve(Array.ofType('__list__'))).to.deep.equal([{ a: 1 }]);
  });

  it('dispose({ plainOwners: true }) disposes a value that has a dispose method', async () => {
    const c = new Container();
    let disposed = false;
    c.register({
      dispose: () => {
        disposed = true;
      },
    }).asValue('__closable__');
    await c.dispose({ plainOwners: true });
    expect(disposed).to.be.true;
  });

  it('dispose() disposes a Service bound as a value once and keeps it registered', async () => {
    const c = new Container();
    const service = new Closable();
    c.register(service).asValue('__service__');
    c.register(service).asValue('Closable');
    await c.dispose();
    expect(service.disposed).to.equal(1);
    expect(c.get('__service__')).to.equal(service);
  });

  it('setting a flag value twice with override keeps one value', () => {
    const c = new Container();
    c.register({ mjs: true }).asValue('__flag__', true);
    c.register({ mjs: true }).asValue('__flag__', true);
    expect(c.get(Array.ofType('__flag__'))).to.have.length(1);
  });

  it('a key holding a value and a class registration lists both and never writes instances into the value list', () => {
    const c = new Container();
    const value = { kind: 'value' };
    c.register(value).asValue('Shape');
    c.register(Square).as(Shape);

    const list = c.resolve(Array.ofType(Shape)) as unknown[];
    expect(list).to.have.length(2);
    expect(list[0]).to.equal(value);
    expect(list[1]).to.be.instanceOf(Square);
    expect(c.Registry.getValues('Shape')).to.deep.equal([value]);

    c.clearCache();
    expect(c.get(Array.ofType('Shape'))).to.deep.equal([value]);
  });
});
