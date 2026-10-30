import 'mocha';
import { expect } from 'chai';

import { Autoinject, DI, forgetPendingProperties, LazyInject, pendingProperties, PROPERTY_TYPE_RESOLVER, ResolveException, Singleton, type Class, type IContainer, type IDeclaredPropertyType, type IPropertyTypeResolver } from '../src/index.js';

class Foo {
  public readonly name = 'foo';
}

class Bar {
  public readonly name = 'bar';
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

class Repo {
  public foo: Foo;

  public find() {
    return this.foo.name;
  }
}
Singleton()(Repo);
Autoinject()(Repo.prototype, 'foo');

class ExplicitOwner {
  public one: Foo;
  public list: Foo[];
  public map: Map<string, Foo>;
}
Autoinject(Foo)(ExplicitOwner.prototype, 'one');
Autoinject(Foo)(ExplicitOwner.prototype, 'list');
Autoinject(Foo, { mapFunc: (x: Foo) => x.name })(ExplicitOwner.prototype, 'map');

class ExplicitLazyOwner {
  public list: Foo[];
  public map: Map<string, Foo>;
}
LazyInject(Foo)(ExplicitLazyOwner.prototype, 'list');
LazyInject(Foo, { mapFunc: (x: Foo) => x.name })(ExplicitLazyOwner.prototype, 'map');

class TwoProperties {
  public a: Foo;
  public b: Bar;
}
Autoinject()(TwoProperties.prototype, 'a');
Autoinject()(TwoProperties.prototype, 'b');

function withResolver(typeOf: IPropertyTypeResolver['typeOf']): IContainer {
  const container = DI.child();
  container.register({ typeOf } satisfies IPropertyTypeResolver).asValue(PROPERTY_TYPE_RESOLVER.key);
  return container;
}

const fooOf = (owner: Class<unknown>, property: string): IDeclaredPropertyType | undefined => ((owner === Owner || owner === OptionalOwner || owner === LazyOwner || owner === Repo) && property === 'foo' ? { type: Foo, array: false } : undefined);

const lists = (_owner: Class<unknown>, property: string): IDeclaredPropertyType => ({ array: property !== 'one' });

describe('property types without decorator metadata', () => {
  it('throws ResolveException naming the class and the property when nothing names the type', () => {
    expect(() => DI.child().resolve(Owner)).to.throw(ResolveException, /Owner\.foo/);
  });

  it('takes the type from the registered property type resolver', () => {
    const owner = withResolver(fooOf).resolve(Owner);
    expect(owner.foo).to.be.instanceOf(Foo);
  });

  it('keeps the first resolve of a sync service sync', () => {
    const repo = withResolver(fooOf).resolve(Repo);
    expect(repo).to.be.instanceOf(Repo);
    expect(repo.find()).to.equal('foo');
  });

  it('keeps the decorator options', () => {
    expect(withResolver(fooOf).resolve(OptionalOwner).foo).to.equal(undefined);

    const container = withResolver(fooOf);
    container.register(Foo).asSelf();
    expect(container.resolve(OptionalOwner).foo).to.be.instanceOf(Foo);
  });

  it('gives @LazyInject() the resolved type, in sync, on the first read', () => {
    const owner = withResolver(fooOf).resolve(LazyOwner);
    expect(owner.foo).to.be.instanceOf(Foo);
    expect(owner.foo.name).to.equal('foo');
  });

  it('keeps a @LazyInject() type per owner: another container answers with its own', () => {
    const first = withResolver(fooOf).resolve(LazyOwner);
    const second = withResolver((owner, property) => (owner === LazyOwner && property === 'foo' ? { type: Bar, array: false } : undefined)).resolve(LazyOwner);
    expect(first.foo).to.be.instanceOf(Foo);
    expect(second.foo).to.be.instanceOf(Bar);
    expect(first.foo).to.be.instanceOf(Foo);
  });

  it('throws when the resolver does not know the property', () => {
    expect(() => withResolver(() => undefined).resolve(Owner)).to.throw(ResolveException, /Owner\.foo: the decorator names no type/);
  });

  it('says what to do when no resolver is registered yet, which is what the manifest needs Configuration for', () => {
    expect(() => DI.child().resolve(Owner)).to.throw(ResolveException, /Owner\.foo.*resolve Configuration first, or pass the type to the decorator/);
  });

  describe('pairs collected at decoration', () => {
    const has = (owner: Class<unknown>, property: string) => pendingProperties().some((p) => p.owner === owner && p.property === property);

    it('lists every property a build without metadata left to the manifest', () => {
      expect(has(Owner, 'foo')).to.equal(true);
      expect(has(LazyOwner, 'foo')).to.equal(true);
    });

    it('lists an explicit class too: only the metadata could tell whether it is a list', () => {
      expect(has(ExplicitOwner, 'list')).to.equal(true);
      expect(has(ExplicitLazyOwner, 'map')).to.equal(true);
    });

    it('lists nothing for a property that has metadata', () => {
      class WithMetadata {
        @Autoinject()
        public foo: Foo;

        @Autoinject(Foo)
        public list: Foo[];
      }
      expect(has(WithMetadata, 'foo')).to.equal(false);
      expect(has(WithMetadata, 'list')).to.equal(false);
    });

    it('lists a pair once', () => {
      class Twice {}
      Autoinject()(Twice.prototype, 'foo');
      Autoinject()(Twice.prototype, 'foo');
      expect(pendingProperties().filter((p) => p.owner === Twice)).to.have.length(1);
    });

    it('forgets on request', () => {
      class Gone {}
      Autoinject()(Gone.prototype, 'foo');
      forgetPendingProperties(Gone);
      expect(has(Gone, 'foo')).to.equal(false);
      expect(has(Owner, 'foo')).to.equal(true);
    });
  });

  it('types no property before throwing, so nothing is left unhandled when a later one fails', async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const container = withResolver((_owner, property) => (property === 'a' ? { type: Foo, array: false } : undefined));
      expect(() => container.resolve(TwoProperties)).to.throw(ResolveException, /TwoProperties\.b/);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listen);
    }
    expect(unhandled).to.deep.equal([]);
  });

  describe('@Autoinject(X) on a list', () => {
    it('injects one instance without anything to say otherwise', () => {
      const container = DI.child();
      container.register(Foo).asSelf();
      expect(container.resolve(ExplicitOwner).list).to.be.instanceOf(Foo);
    });

    it('applies array from the resolver', () => {
      const container = withResolver(lists);
      container.register(Foo).asSelf();
      const owner = container.resolve(ExplicitOwner);
      expect(owner.one).to.be.instanceOf(Foo);
      expect(owner.list).to.be.an('array').with.length(1);
      expect(owner.list[0]).to.be.instanceOf(Foo);
    });

    it('applies the map function', () => {
      const container = withResolver(lists);
      container.register(Foo).asSelf();
      const { map } = container.resolve(ExplicitOwner);
      expect(map).to.be.instanceOf(Map);
      expect(map.get('foo')).to.be.instanceOf(Foo);
    });

    it('does the same for @LazyInject(X)', () => {
      const container = withResolver(lists);
      container.register(Foo).asSelf();
      const owner = container.resolve(ExplicitLazyOwner);
      expect(owner.list).to.be.an('array').with.length(1);
      expect(owner.map).to.be.instanceOf(Map);
    });

    describe('with nothing to ask yet', () => {
      class Early {
        public list: Foo[];
      }
      class EarlyLazy {
        public list: Foo[];
      }
      class Asked {
        public list: Foo[];
      }

      const boundSingle = (owner: Class<unknown>) => pendingProperties().find((p) => p.owner === owner)?.boundSingle;

      before(() => {
        Autoinject(Foo)(Early.prototype, 'list');
        LazyInject(Foo)(EarlyLazy.prototype, 'list');
        Autoinject(Foo)(Asked.prototype, 'list');
      });

      it('remembers that the property got one instance, for whoever can tell later that it is a list', () => {
        const container = DI.child();
        container.register(Foo).asSelf();
        container.resolve(Early);
        container.resolve(EarlyLazy);
        expect(boundSingle(Early)).to.equal(true);
        expect(boundSingle(EarlyLazy)).to.equal(true);
      });

      it('needs no one to ask when the decorator states the list', () => {
        class Stated {
          public list: Foo[];
        }
        Autoinject(Array.ofType(Foo))(Stated.prototype, 'list');
        const container = DI.child();
        container.register(Foo).asSelf();
        expect(container.resolve(Stated).list).to.be.an('array').with.length(1);
        expect(boundSingle(Stated)).to.equal(undefined);
      });

      it('remembers nothing when a resolver answered', () => {
        const container = withResolver(lists);
        container.register(Foo).asSelf();
        container.resolve(Asked);
        expect(boundSingle(Asked)).to.equal(undefined);
      });
    });
  });
});
