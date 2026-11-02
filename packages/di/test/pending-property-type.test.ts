import 'mocha';
import { expect } from 'chai';

import { Autoinject, DI, LazyInject, PROPERTY_TYPE_RESOLVER, ResolveException, type Class, type IContainer, type IPropertyTypeResolver } from '../src/index.js';

class Foo {
  public readonly name = 'foo';
}

// Applied by hand: TypeScript emits `design:type` only for decorators it applies itself, so these have no metadata.
class Owner {
  public foo: Foo;
}
Autoinject()(Owner.prototype, 'foo');

class OptionalOwner {
  public foo?: Foo;
}
Autoinject({ optional: true })(OptionalOwner.prototype, 'foo');

class LazyOwner {
  public foo: Foo;
}
LazyInject()(LazyOwner.prototype, 'foo');

function withResolver(typeOf: IPropertyTypeResolver['typeOf']): IContainer {
  const container = DI.child();
  container.register({ typeOf } satisfies IPropertyTypeResolver).asValue(PROPERTY_TYPE_RESOLVER.key);
  return container;
}

const fooOf = (owner: Class<unknown>, property: string) => (owner === Owner || owner === OptionalOwner || owner === LazyOwner) && property === 'foo' ? Foo : undefined;

describe('property types without decorator metadata', () => {
  it('throws ResolveException naming the class and the property when nothing names the type', () => {
    expect(() => DI.child().resolve(Owner)).to.throw(ResolveException, /Owner\.foo/);
  });

  it('takes the type from the registered property type resolver', () => {
    const owner = withResolver(fooOf).resolve(Owner);
    expect(owner.foo).to.be.instanceOf(Foo);
  });

  it('waits for a resolver that has to load the type', async () => {
    const owner = await withResolver((o, p) => Promise.resolve(fooOf(o, p)!)).resolve(Owner);
    expect(owner.foo).to.be.instanceOf(Foo);
  });

  it('keeps the decorator options', () => {
    expect(withResolver(fooOf).resolve(OptionalOwner).foo).to.equal(undefined);

    const container = withResolver(fooOf);
    container.register(Foo).asSelf();
    expect(container.resolve(OptionalOwner).foo).to.be.instanceOf(Foo);
  });

  it('gives @LazyInject() the resolved type', () => {
    const owner = withResolver(fooOf).resolve(LazyOwner);
    expect(owner.foo.name).to.equal('foo');
  });

  it('throws when the resolver does not know the property', () => {
    expect(() => withResolver(() => undefined).resolve(Owner)).to.throw(ResolveException, /Owner\.foo/);
  });
});
