import * as chai from 'chai';
import 'mocha';
import { Container, PerChildInstance, ServiceNotFound, Singleton } from '@spinajs/di';

import { AuthzConfigError, pickNamed } from '@spinajs/authz';

const expect = chai.expect;

abstract class Sink {
  abstract readonly id: string;
}

class FirstSink extends Sink {
  readonly id = 'first';
}

class SecondSink extends Sink {
  readonly id = 'second';
}

@Singleton()
class SharedSink extends Sink {
  readonly id = 'shared';
}

@PerChildInstance()
class LocalSink extends Sink {
  readonly id = 'local';
}

// Stands for a class whose dependency DI cannot find.
class NeedySink extends Sink {
  readonly id = 'needy';

  constructor() {
    super();
    throw new ServiceNotFound('Service Dependency is not registered in DI container');
  }
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('pickNamed', () => {
  it('without a name gives the last registration, or undefined and registers nothing', async () => {
    const empty = new Container();
    expect(await pickNamed(empty, Sink, undefined, 'k', 'here')).to.equal(undefined);
    expect(empty.hasRegistered(Sink)).to.equal(false);

    const c = new Container();
    c.register(FirstSink).as(Sink);
    c.register(SecondSink).as(Sink);
    expect((await pickNamed(c, Sink, undefined, 'k', 'here'))!.id).to.equal('second');
  });

  it('picks the registration by class name and builds only that one', async () => {
    const c = new Container();
    c.register(FirstSink).as(Sink);
    c.register(SecondSink).as(Sink);
    expect((await pickNamed(c, Sink, 'FirstSink', 'k', 'here')).id).to.equal('first');
    expect(c.Cache.has(SecondSink)).to.equal(false);
  });

  it('the nearest registration of a name wins: a child registration over its parent', async () => {
    const named = (id: string) =>
      class Named extends Sink {
        readonly id = id;
      };
    const parent = new Container();
    const child = parent.child();
    parent.register(named('parent')).as(Sink);
    parent.register(FirstSink).as(Sink);
    expect((await pickNamed(child, Sink, 'Named', 'k', 'here')).id).to.equal('parent');
    const late = parent.child();
    late.register(named('child')).as(Sink);
    expect((await pickNamed(late, Sink, 'Named', 'k', 'here')).id).to.equal('child');
    expect((await pickNamed(parent, Sink, 'Named', 'k', 'here')).id).to.equal('parent');
  });

  it('resolves a per-child class in the asking container and any other class where it was registered', async () => {
    const root = new Container();
    root.register(SharedSink).as(Sink);
    root.register(LocalSink).as(Sink);
    const a = root.child();
    const b = root.child();

    const sharedA = await pickNamed(a, Sink, 'SharedSink', 'k', 'here');
    expect(await pickNamed(b, Sink, 'SharedSink', 'k', 'here')).to.equal(sharedA);
    expect(root.Cache.has(SharedSink)).to.equal(true);

    const localA = await pickNamed(a, Sink, 'LocalSink', 'k', 'here');
    const localB = await pickNamed(b, Sink, 'LocalSink', 'k', 'here');
    expect(localA).to.be.instanceOf(LocalSink);
    expect(localB).to.not.equal(localA);
    expect(await pickNamed(a, Sink, 'LocalSink', 'k', 'here')).to.equal(localA);
  });

  it('refuses an unknown name with an AuthzConfigError naming the key', async () => {
    const c = new Container();
    c.register(FirstSink).as(Sink);
    const err = await rejection(pickNamed(c, Sink, 'Missing', 'authz.audit.service', 'Authz domain "x"'));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.equal('Authz domain "x": authz.audit.service names "Missing", but no Sink class of that name is registered');
    expect((err as Error & { cause?: unknown }).cause).to.be.instanceOf(ServiceNotFound);
  });

  it('passes on a ServiceNotFound from building a registered class', async () => {
    const c = new Container();
    c.register(NeedySink).as(Sink);
    const err = await rejection(pickNamed(c, Sink, 'NeedySink', 'k', 'here'));
    expect(err).to.be.instanceOf(ServiceNotFound);
    expect(err).to.not.be.instanceOf(AuthzConfigError);
  });
});
