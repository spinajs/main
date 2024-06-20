import { IInstanceCheck } from './../src/interfaces.js';
import { InvalidArgument } from '@spinajs/exceptions';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mock, spy } from 'sinon';

import 'mocha';
import { Autoinject, Container, DI, Inject, Injectable, LazyInject, NewInstance, PerChildInstance, Singleton, IInjectDescriptor, AddDependencyForProperty, Class, PerInstance, AsyncService, SyncService, PerInstanceCheck } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class NoRegisteredType {}

class InjectableBase {}
@Injectable(InjectableBase)
export class InjectableTest {}

@Injectable(InjectableBase)
export class InjectableTest2 {}

@Singleton()
class Foo {
  public static Counter: number;

  public static initialize() {
    Foo.Counter = 0;
  }

  constructor() {
    Foo.Counter++;
  }
}

@NewInstance()
class A {

  public static Counter: number = 0;

  constructor() {
    A.Counter++;
  }
}

class B {
  @Autoinject()
  public A : A;
}

class C extends B {}

class D extends C {} 

@NewInstance()
class BarFar {
  public static Counter: number;
  public static initialize() {
    BarFar.Counter = 0;
  }

  public InstanceCounter = 0;
  constructor() {
    BarFar.Counter++;
    this.InstanceCounter++;
  }
}

BarFar.initialize();

class InhZar {
  @Autoinject()
  public Foo: Foo;
}

@NewInstance()
class BarFarZar extends InhZar {
  public static Counter: number;
  public static initialize() {
    BarFarZar.Counter = 0;
  }

  public InstanceCounter = 0;
  constructor() {
    super();

    BarFarZar.Counter++;
    this.InstanceCounter++;
  }
}

BarFarZar.initialize();

@PerChildInstance()
class Far {
  public static Counter: number;
  public static initialize() {
    Far.Counter = 0;
  }

  constructor() {
    Far.Counter++;
  }
}
Far.initialize();

class Zar {}

class AutoinjectBar {}

class AutoinjectClass {
  @Autoinject()
  public Test: AutoinjectBar = null;
}

class LazyInjectDep {
  public static Counter: number;

  constructor() {
    LazyInjectDep.Counter++;
  }
}

LazyInjectDep.Counter = 0;

class LazyInjectResolve {
  @LazyInject(LazyInjectDep)
  public Instance: LazyInjectDep;

  public get Test() {
    return 'fff';
  }

  public Foo = 11;
}

class LazyInjectResolve2 {
  @LazyInject()
  public Instance: LazyInjectDep;

  public get Test() {
    return 'fff';
  }

  public Foo = 11;
}

abstract class SampleBaseClass {
  public ServiceName: string;
}

class SampleImplementation1 extends SampleBaseClass {
  constructor() {
    super();

    this.ServiceName = 'Sample1';
  }
}

class SampleImplementation2 extends SampleBaseClass {
  constructor() {
    super();

    this.ServiceName = 'Sample2';
  }
}

@Singleton()
class TestModule extends SyncService {
  public Initialized = false;

  // tslint:disable-next-line: no-empty
  public resolve() {
    this.Initialized = true;
  }
}

@Inject(Container)
class TestInjectContainerAsParameter {
  constructor(public container: Container) {}
}

class TestInjectContainerAsProperty {
  @Autoinject()
  public container: Container;
}

class BaseInject {}

@Inject(BaseInject)
class BaseClass {
  constructor(public baseInject: BaseInject) {}
}

class ChildClass extends BaseClass {}

export function AutoinjectService(service: string) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>;
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: service,
      serviceFunc: (data: string) => {
        return {
          service: data,
        };
      },
    });
  });
}

export function AutoinjectServiceArray(service: string[], type?: Class<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string) => {
    const t = type ?? (Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>);
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: t,
      data: service,
      mapFunc: (x: any) => {
        return x.Name || x.constructor.name;
      },
      serviceFunc: (data: any[]) => {
        return data.map((x) => {
          return {
            service: x as string,
          };
        });
      },
    });
  });
}

class __A {}
class __B {}
class __C {}

class BaseFoo {
  @Autoinject(__A)
  public Foo: __A;
}

class DerivedFoo extends BaseFoo {
  @Autoinject(__B)
  public Foo1: __B;

  @Autoinject(__B)
  public Foo2: __B;
}
class DerivedFoo2 extends BaseFoo {
  @Autoinject(__C)
  public Foo1: __C;
}

describe('Dependency injection', () => {
  beforeEach(() => {
    DI.clear();
    Foo.initialize();
  });

  it('Should not inject multiple times same dep when using @Inject with inheritance', () => {
    class _AA {}

    @Inject(_AA)
    class _ZZ {
      constructor(public a: _AA) {}
    }

    @Inject(_AA)
    class _ZY extends _ZZ {
      constructor(public a: _AA, public b: _AA) {
        super(a);
      }
    }

    const val = DI.resolve(_ZY);

    expect(val.a).to.be.not.undefined;
    expect(val.b).to.be.undefined;
  });

  it('Manual registering should preserve options from decoration', () => {
    class _ZZ {}

    class _DD {
      @Autoinject(_ZZ)
      public Z: _ZZ;
    }

    DI.register(_DD).asSelf().singleInstance();

    const v = DI.resolve(_DD);

    expect(v.Z).to.not.be.null;
  });

  it('Should not leak dependencies when derived from base class', async () => {
    const inst1 = DI.resolve(DerivedFoo);
    const inst2 = DI.resolve(DerivedFoo2);

    expect(inst1.Foo.constructor.name).to.eq('__A');
    expect(inst1.Foo1.constructor.name).to.eq('__B');
    expect(inst1.Foo2.constructor.name).to.eq('__B');
    expect(inst2.Foo.constructor.name).to.eq('__A');
    expect(inst2.Foo1.constructor.name).to.eq('__C');
  });

  it('Inject container', () => {
    const root = DI.RootContainer;
    const instance = DI.resolve<TestInjectContainerAsParameter>(TestInjectContainerAsParameter);
    const instance2 = DI.resolve<TestInjectContainerAsProperty>(TestInjectContainerAsProperty);
    expect(instance.container === root).to.be.true;
    expect(instance2.container === root).to.be.true;
  });

  it('Injectable should register class', () => {
    @Injectable()
    class InjectableTest {}

    const registry = DI.RootContainer.Registry;

    expect(registry.getTypes(InjectableTest)).to.be.an('array').that.have.length(1);
    expect(registry.getTypes(InjectableTest)[0]).to.be.not.null;
    expect(DI.resolve(InjectableTest)).to.be.not.null;
  });

  it('Injectable should register class as another', () => {
    class InjectableBase {}

    @Injectable(InjectableBase)
    class InjectableTest {}

    const registry = DI.RootContainer.Registry;

    expect(registry.getTypes(InjectableBase)).to.be.an('array').that.have.length(1);
    expect(registry.getTypes(InjectableBase)[0]).to.be.not.null;
    expect(registry.getTypes(InjectableBase)[0].name).to.eq('InjectableTest');
    expect(DI.resolve(InjectableBase)).to.be.instanceOf(InjectableTest);
  });

  it('Injectable should register multiple class as another', () => {
    class InjectableBase {}

    @Injectable(InjectableBase)
    class InjectableTest {}

    @Injectable(InjectableBase)
    class InjectableTest2 {}

    const registry = DI.RootContainer.Registry;

    expect(registry.getTypes(InjectableBase)).to.be.an('array').that.have.length(2);
    expect(registry.getTypes(InjectableBase)[0]).to.be.not.null;
    expect(registry.getTypes(InjectableBase)[0].name).to.eq('InjectableTest');

    const services = DI.resolve<InjectableBase>(Array.ofType(InjectableBase));
    expect(services).to.be.an('array').that.have.length(2);
    expect(services[0]).to.be.instanceOf(InjectableTest);
    expect(services[1]).to.be.instanceOf(InjectableTest2);
  });

  it('Inject child container', () => {
    const child = DI.child();
    const instance = child.resolve<TestInjectContainerAsParameter>(TestInjectContainerAsParameter);
    const instance2 = child.resolve<TestInjectContainerAsProperty>(TestInjectContainerAsProperty);
    const root = DI.RootContainer;
    expect(instance.container === root).to.be.false;
    expect(instance2.container === root).to.be.false;
    expect(instance.container === child).to.be.true;
    expect(instance2.container === child).to.be.true;
  });

  it('Should inject on base class declaration', () => {
    const instance = DI.resolve<ChildClass>(ChildClass);
    expect(instance.baseInject).to.be.not.null;
    expect(instance.baseInject instanceof BaseInject).to.be.true;
  });

  it('Framework module initialization strategy', () => {
    const module = DI.resolve(TestModule);

    expect(module).to.be.not.null;
    expect(module.Initialized).to.be.true;
  });

  it('Register multiple classes with same base class', () => {
    DI.register(SampleImplementation1).as(SampleBaseClass);
    DI.register(SampleImplementation2).as(SampleBaseClass);

    const val = DI.resolve<SampleBaseClass>(Array.ofType(SampleBaseClass));
    expect(val).to.be.not.null;
    expect(val.length).to.eq(2);
    expect(val[0] instanceof SampleImplementation1).to.be.true;
    expect(val[1] instanceof SampleImplementation2).to.be.true;
  });

  it('Autoinject resolve', () => {
    const autoinjected = DI.resolve<AutoinjectClass>(AutoinjectClass);

    expect(autoinjected).to.be.not.null;
    expect(autoinjected.Test).to.be.not.null;
    expect(autoinjected.Test instanceof AutoinjectBar).to.be.true;
  });

  it('Autoinject resolve as Map', () => {
    DI.register(SampleImplementation1).as(SampleBaseClass);
    DI.register(SampleImplementation2).as(SampleBaseClass);

    class SampleMultipleAutoinject {
      @Autoinject(SampleBaseClass, {
        mapFunc: (x) => x.ServiceName,
      })
      public Instances: Map<string, SampleBaseClass>;
    }

    const instance = DI.resolve(SampleMultipleAutoinject);

    expect(instance).to.be.not.null;
    expect(instance.Instances).to.be.an('map').of.length(2);
    expect(instance.Instances.has('Sample1')).to.be.true;
    expect(instance.Instances.has('Sample2')).to.be.true;
  });

  it('Autoinject resolve multiple implementations', () => {
    DI.register(SampleImplementation1).as(SampleBaseClass);
    DI.register(SampleImplementation2).as(SampleBaseClass);

    class SampleMultipleAutoinject {
      @Autoinject(SampleBaseClass)
      public Instances: SampleBaseClass[];
    }

    const instance = DI.resolve(SampleMultipleAutoinject);

    expect(instance).to.be.not.null;
    expect(instance.Instances).to.be.an('array').of.length(2);
  });

  it('Should autoinject with service func returned array', () => {
    @NewInstance()
    class SampleImplementation1Single extends SampleBaseClass {
      constructor() {
        super();
      }
    }

    @NewInstance()
    class SampleImplementation2Single extends SampleBaseClass {
      constructor() {
        super();
      }
    }
    class SampleMultipleAutoinjectArray {
      @AutoinjectServiceArray(['SampleImplementation1Single', 'SampleImplementation2Single'], SampleBaseClass)
      public Service: Map<string, SampleBaseClass>;
    }

    DI.register(SampleImplementation1Single).as(SampleBaseClass);
    DI.register(SampleImplementation2Single).as(SampleBaseClass);

    const instance = DI.resolve(SampleMultipleAutoinjectArray);
    expect(instance).to.be.not.null;
    expect(instance.Service).to.be.not.null;

    expect(instance.Service.get('SampleImplementation1Single')).to.be.not.null;
    expect(instance.Service.get('SampleImplementation2Single')).to.be.not.null;
    expect(instance.Service.get('SampleImplementation1Single').constructor.name).to.eq('SampleImplementation1Single');
    expect(instance.Service.get('SampleImplementation2Single').constructor.name).to.eq('SampleImplementation2Single');
  });

  it('Should autoinject with additional options', () => {
    class SampleImplementation1Single extends SampleBaseClass {
      constructor(public options: any) {
        super();
      }
    }
    DI.register(SampleImplementation1Single).as(SampleBaseClass);

    class SampleMultipleAutoinject {
      @Autoinject({
        options: {
          foo: 'bar',
        },
      })
      public Service: SampleBaseClass;
    }

    const instance = DI.resolve(SampleMultipleAutoinject);
    expect(instance).to.be.not.null;
    expect(instance.Service).to.be.not.null;
    expect((instance.Service as SampleImplementation1Single).options).to.be.not.null;
    expect((instance.Service as SampleImplementation1Single).options.foo).to.eq('bar');
  });

  it('Should autoinject with service func', () => {
    @PerInstance()
    class SampleImplementation1Single extends SampleBaseClass {
      constructor() {
        super();
      }
    }

    @PerInstance()
    class SampleImplementation2Single extends SampleBaseClass {
      constructor() {
        super();
      }
    }

    @PerInstance()
    class SampleImplementation3Single extends SampleBaseClass {
      constructor() {
        super();
      }
    }

    DI.register(SampleImplementation1Single).as(SampleBaseClass);
    DI.register(SampleImplementation2Single).as(SampleBaseClass);
    DI.register(SampleImplementation3Single).as(SampleBaseClass);
    class SampleMultipleAutoinject {
      @AutoinjectService('SampleImplementation2Single')
      public Service: SampleBaseClass;
    }
    class SampleMultipleAutoinject2 {
      @Autoinject()
      public Service: SampleBaseClass;
    }

    class SampleMultipleAutoinject3 {
      @Autoinject(SampleImplementation1Single)
      public Service: SampleBaseClass;
    }

    const instance = DI.resolve(SampleMultipleAutoinject);
    const instance2 = DI.resolve(SampleMultipleAutoinject2);
    const instance3 = DI.resolve(SampleMultipleAutoinject3);

    expect(instance).to.be.not.null;
    expect(instance.Service).to.be.not.null;
    expect(instance.Service.constructor.name).to.eq('SampleImplementation2Single');
    expect(instance2.Service.constructor.name).to.eq('SampleImplementation3Single');
    expect(instance3.Service.constructor.name).to.eq('SampleImplementation1Single');
  });

  it('Should autoinject multiple as singleton', () => {
    @Singleton()
    class SampleImplementation1Single extends SampleBaseClass {
      public static CallCount = 0;
      constructor() {
        super();

        this.ServiceName = 'Sample1';

        SampleImplementation1Single.CallCount++;
      }
    }

    @Singleton()
    class SampleImplementation2Single extends SampleBaseClass {
      public static CallCount = 0;

      constructor() {
        super();

        this.ServiceName = 'Sample2';

        SampleImplementation2Single.CallCount++;
      }
    }

    DI.register(SampleImplementation1Single).as(SampleBaseClass);
    DI.register(SampleImplementation2Single).as(SampleBaseClass);
    class SampleMultipleAutoinject {
      @Autoinject(SampleBaseClass)
      public Instances: SampleBaseClass[];
    }

    class SampleMultiple2Autoinject {
      @Autoinject(SampleBaseClass)
      public Instances: SampleBaseClass[];
    }

    const instance = DI.resolve(SampleMultipleAutoinject);
    const instance2 = DI.resolve(SampleMultiple2Autoinject);

    expect(instance2).to.be.not.null;
    expect(instance).to.be.not.null;
    expect(instance.Instances).to.be.an('array').of.length(2);
    expect(SampleImplementation1Single.CallCount).to.equal(1);
    expect(SampleImplementation2Single.CallCount).to.equal(1);
  });

  it('Lazy inject check', () => {
    const lazyinject = DI.resolve<LazyInjectResolve>(LazyInjectResolve);

    expect(LazyInjectDep.Counter).to.eq(0);

    const dep = lazyinject.Instance;
    expect(dep).to.be.instanceof(LazyInjectDep);
  });

  it('Lazy inject check withoud type set explicit', () => {
    const lazyinject = DI.resolve<LazyInjectResolve2>(LazyInjectResolve2);

    expect(LazyInjectDep.Counter).to.eq(1);

    const dep = lazyinject.Instance;
    expect(dep).to.be.instanceof(LazyInjectDep);
  });

  it('Singleton creation', () => {
    // root
    const single = DI.resolve<Foo>(Foo);
    const single2 = DI.resolve<Foo>(Foo);

    expect(Foo.Counter).to.eq(1);
    expect(single === single2).to.equal(true);

    // child
    {
      const child = DI.child();
      const single3 = child.resolve<Foo>(Foo);
      const single4 = child.resolve<Foo>(Foo);

      expect(Foo.Counter).to.eq(1);
      expect(single === single3 && single === single4).to.equal(true);

      // second level child
      {
        const child2 = child.child();
        const single5 = child2.resolve<Foo>(Foo);
        const single6 = child2.resolve<Foo>(Foo);

        expect(Foo.Counter).to.eq(1);
        expect(single === single5 && single === single6).to.equal(true);
      }
    }
  });

  it('New instance creation', () => {
    const single = DI.resolve<BarFar>(BarFar);
    const single2 = DI.resolve<BarFar>(BarFar);

    expect(BarFar.Counter).to.eq(2);
    expect(single.InstanceCounter).to.eq(1);
    expect(single2.InstanceCounter).to.eq(1);
    expect(single === single2).to.equal(false);

    {
      const child = DI.child();
      const single3 = child.resolve<BarFar>(BarFar);
      const single4 = child.resolve<BarFar>(BarFar);

      expect(BarFar.Counter).to.eq(4);
      expect(single3.InstanceCounter).to.eq(1);
      expect(single4.InstanceCounter).to.eq(1);
      expect(single3 === single4).to.equal(false);
      expect(single3 === single).to.equal(false);
    }
  });

  it('New instance creation with inheritance', () => {
    const single = DI.resolve<BarFarZar>(BarFarZar);
    const single2 = DI.resolve<BarFarZar>(BarFarZar);

    expect(BarFarZar.Counter).to.eq(2);
    expect(single.InstanceCounter).to.eq(1);
    expect(single2.InstanceCounter).to.eq(1);
    expect(single === single2).to.equal(false);

    {
      const child = DI.child();
      const single3 = child.resolve<BarFarZar>(BarFarZar);
      const single4 = child.resolve<BarFarZar>(BarFarZar);

      expect(BarFarZar.Counter).to.eq(4);
      expect(single3.InstanceCounter).to.eq(1);
      expect(single4.InstanceCounter).to.eq(1);
      expect(single3 === single4).to.equal(false);
      expect(single3 === single).to.equal(false);
    }
  });

  it('Per child container creation', () => {
    // root
    const single = DI.resolve<Far>(Far);
    const single2 = DI.resolve<Far>(Far);

    expect(Far.Counter).to.eq(1);
    expect(single === single2).to.equal(true);

    // child
    {
      const child = DI.child();
      const single3 = child.resolve<Far>(Far);
      const single4 = child.resolve<Far>(Far);

      expect(Far.Counter).to.eq(2);
      expect(single3 === single4).to.equal(true);
      expect(single3 === single).to.equal(false);
    }
  });

  it('Register type as self', () => {
    DI.register(Zar).asSelf();

    const zar = DI.resolve(Zar);
    expect(zar).to.be.not.null;
    expect(zar.constructor.name).to.equal(Zar.name);
  });

  it('Register type as implementation of another', () => {
    class RegisterBase {}
    class RegisterImpl implements RegisterBase {}

    DI.register(RegisterImpl).as(RegisterBase);

    const instance = DI.resolve(RegisterBase);
    expect(instance).to.be.not.null;
    expect(instance.constructor.name).to.equal(RegisterImpl.name);
  });

  it('Register type as singleton', () => {
    class RegisterBase {
      public static Count: number;
    }
    RegisterBase.Count = 0;
    class RegisterImpl implements RegisterBase {
      public static Count: number;
      constructor() {
        RegisterImpl.Count++;
      }
    }
    RegisterImpl.Count = 0;

    DI.register(RegisterImpl).as(RegisterBase);

    const instance = DI.resolve(RegisterBase);
    const instance2 = DI.resolve(RegisterBase);

    expect(instance).to.be.not.null;
    expect(instance2).to.be.not.null;

    expect(RegisterImpl.Count).to.eq(1);

    expect(instance.constructor.name).to.equal(RegisterImpl.name);
  });

  it('Should resolve async', async () => {
    DI.clear();

    class Test extends AsyncService {
      public Initialized = false;

      public async resolve() {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            this.Initialized = true;
            resolve();
          }, 200);
        });
      }
    }

    const instance = await DI.resolve(Test);

    expect(instance instanceof Test).to.be.true;
    expect(DI.get('Test')).to.be.not.null;
    expect(instance.Initialized).to.be.true;
  });

  it('Should resolve sync', () => {
    DI.clear();

    class Test extends SyncService {
      public Initialized = false;

      public resolve() {
        this.Initialized = true;
      }
    }

    const instance = DI.resolve(Test);

    expect(instance instanceof Test).to.be.true;
    expect(DI.get('Test')).to.be.not.null;
    expect(instance.Initialized).to.be.true;
  });

  it('Should clear container', () => {
    class Test {}

    DI.resolve(Test);
    expect(DI.get('Test')).to.be.not.null;
    DI.clear();
    expect(DI.get('Test')).to.be.undefined;
  });

  it('Should get if type is already resolved', () => {
    class Test {}

    DI.resolve(Test);

    expect(DI.get('Test')).to.be.not.null;
  });

  it('Get should return undefined if type is not already resolved', () => {
    expect(DI.get('Test')).to.be.undefined;
  });

  it('Should throw if type is unknown', () => {
    return expect(() => DI.resolve(undefined)).to.throw(InvalidArgument, 'argument `type` cannot be null or undefined');
  });

  it('Should resolve from factory func', () => {
    class IDatabase {}

    class DatabaseImpl implements IDatabase {}

    DI.register((container: Container, connString: string) => {
      expect(container).to.be.not.null;
      expect(container.constructor.name).to.eq('Container');
      expect(connString).to.eq('root@localhost');
      return new DatabaseImpl();
    }).as(IDatabase);

    const instance = DI.resolve<IDatabase>(IDatabase, ['root@localhost']);
    expect(instance).to.be.not.null;
    expect(instance.constructor.name).to.eq('DatabaseImpl');
  });

  it('Should resolve from factory func with no args', () => {
    class IDatabase {}

    class DatabaseImpl implements IDatabase {}

    DI.register((container: Container) => {
      expect(container).to.be.not.null;
      expect(container.constructor.name).to.eq('Container');
      return new DatabaseImpl();
    }).as(IDatabase);

    const instance = DI.resolve<IDatabase>(IDatabase);
    expect(instance).to.be.not.null;
    expect(instance.constructor.name).to.eq('DatabaseImpl');
  });

  it('Should resolve from factory as different objects', () => {
    class IDatabase {}

    class DatabaseImpl implements IDatabase {}

    const factory = (container: Container) => {
      expect(container).to.be.not.null;
      expect(container.constructor.name).to.eq('Container');
      return new DatabaseImpl();
    };

    DI.register(factory).as(IDatabase);

    const instance = DI.resolve<IDatabase>(IDatabase);
    const instance2 = DI.resolve<IDatabase>(IDatabase);

    expect(instance).to.be.not.null;
    expect(instance.constructor.name).to.eq('DatabaseImpl');
    expect(instance2 !== instance).to.be.true;
  });

  it('Should inject options at resolve', () => {
    class Bar {}

    @Inject(Bar)
    class Test {
      public A: string;
      public B: number;
      public Bar: Bar;

      constructor(bar: Bar, a: string, b: number) {
        this.A = a;
        this.B = b;
        this.Bar = bar;
      }
    }

    const instance = DI.resolve<Test>(Test, ['a', 1]);
    expect(instance.A).to.eq('a');
    expect(instance.B).to.eq(1);
    expect(instance.Bar).to.be.not.null;
    expect(instance.Bar.constructor.name).to.be.eq('Bar');
  });

  it('Should construct child container', () => {
    const child = DI.RootContainer.child();
    expect(child).to.be.not.null;
  });

  it('Should override factory func', () => {
    DI.register(() => 'Foo').as('_factory_');
    DI.register(() => 'Bar').as('_factory_');

    const result = DI.resolve<string>('_factory_');
    expect(result).to.eq('Bar');
  });

  it('Should check if registered', () => {
    @Injectable()
    class FooBar {}

    class ZarFar {}

    expect(DI.check(FooBar)).to.eq(true);
    expect(DI.check(ZarFar)).to.eq(false);
  });

  it('Should check if registered with parent', () => {
    @Injectable()
    class FooBar {}

    class ZarFar {}

    {
      const child = DI.child();

      expect(child.hasRegistered(FooBar, true)).to.eq(true);
      expect(child.hasRegistered(FooBar, false)).to.eq(false);

      expect(child.hasRegistered(ZarFar, true)).to.eq(false);
      expect(child.hasRegistered(ZarFar, false)).to.eq(false);
    }
  });

  it('Should throw if resolving with check', () => {
    class FooBar {}
    expect(() => {
      DI.resolve(FooBar, true);
    }).to.throw;
  });

  it('Should get All with Array.typeOf', async () => {
    class InjectableBase {}

    @Injectable(InjectableBase)
    class InjectableTest {}

    @Injectable(InjectableBase)
    class InjectableTest2 {}

    await DI.resolve(Array.ofType(InjectableBase));

    const getted = DI.get(Array.ofType(InjectableBase));

    expect(getted).to.be.an('array').that.have.length(2);
    expect(getted[0]).to.be.instanceOf(InjectableTest);
    expect(getted[1]).to.be.instanceOf(InjectableTest2);
  });

  it('Should return empty arrat when trying to resolve array type', () => {
    const t = DI.resolve(Array.ofType(NoRegisteredType));
    expect(t).to.be.an('array').and.to.have.lengthOf(0);
  });

  it('Should @Inject should resolve all implementations', () => {
    DI.register(InjectableTest).as(InjectableBase);
    DI.register(InjectableTest2).as(InjectableBase);

    @Inject(Array.ofType(InjectableBase))
    class ResolvableClass {
      public Instances: InjectableBase[];

      constructor(_instances: InjectableBase[]) {
        this.Instances = _instances;
      }
    }

    const instance = DI.resolve(ResolvableClass);

    expect(instance).to.be.not.null;
    expect(instance.Instances).to.be.an('array').of.length(2);
  });

  it('Should throw when resolve with check', () => {
    class BarFart {}

    expect(() => {
      DI.resolve(BarFart, true);
    }).to.throw();

    expect(() => {
      DI.resolve(BarFart, [1], true);
    }).to.throw();
  });

  it('Should register singleton at resolve', () => {
    class PisFart {}

    DI.resolve(PisFart);

    expect(DI.check(PisFart)).to.eq(true);
  });

  it('Should not register at resolve @NewInstance', () => {
    @NewInstance()
    class POFart {}

    DI.resolve(POFart);

    expect(DI.check(POFart)).to.eq(false);
  });

  it('Should register class with as string name', () => {
    class FuPIS {}

    DI.register(FuPIS).as('FuPIS');

    expect(DI.check('FuPIS')).to.eq(true);

    const instance = DI.resolve('FuPIS');
    expect(instance).to.be.not.null;
  });

  it('should resolve on multiple inheritance with mixed decorators', () => {
    class Foo {}

    class Bar {}

    class A {
      @Autoinject(Foo)
      public Foo: Foo;
    }

    class B extends A {}

    @Inject(Bar)
    class C extends B {
      constructor(public Bar: Bar) {
        super();
      }
    }

    const entity = DI.resolve(C);

    expect(entity.Foo).to.be.not.null;
    expect(entity.Bar).to.be.not.null;

    expect(entity.Foo).to.be.not.undefined;
    expect(entity.Bar).to.be.not.undefined;
  });

  it('Resolve with check in registry should look in parent containers', () => {
    class Foo {
      public Count = 1;
    }

    class Bar extends Foo {
      constructor() {
        super();

        this.Count++;
      }
    }

    DI.register(Bar).as(Foo);
    const child = DI.child();

    const instance = child.resolve(Foo, true);
    expect(instance).instanceOf(Bar);
  });

  it('Resolve should check for resolved services in parent containers', () => {
    class Foo {}

    class Bar extends Foo {
      constructor() {
        super();
      }
    }

    DI.register(Bar).as(Foo);
    const parentInstance = DI.resolve(Foo);
    const child = DI.child();

    const instance = child.resolve(Foo);
    expect(instance).instanceOf(Bar);
    expect(instance).to.eq(parentInstance);
  });

  it('Should resolve factory function as string', async () => {
    DI.register(() => {
      return { id: 1 };
    }).as('Test');

    const instance = await DI.resolve('Test');
    expect(instance).to.include({ id: 1 });
  });

  it('Should register asValue', () => {
    DI.register({ id: 1 }).asValue('Test');

    const instance = DI.get('Test');
    expect(instance).to.include({ id: 1 });
  });

  it('Should register multiple asValue and get last', () => {
    DI.register({ id: 1 }).asValue('Test');
    DI.register({ id: 2 }).asValue('Test');

    const instance = DI.get('Test');
    expect(instance).to.include({ id: 2 });
  });

  it('Should register multiple asValue', () => {
    DI.register({ id: 1 }).asValue('Test');
    DI.register({ id: 2 }).asValue('Test');

    const instance = DI.get(Array.ofType('Test'));
    expect(instance[0]).to.include({ id: 1 });
    expect(instance[1]).to.include({ id: 2 });
  });

  it('Should register asValue but with override', () => {
    DI.register({ id: 1 }).asValue('Test');

    DI.register({ id: 2 }).asValue('Test', true);

    const instance = DI.get('Test');
    expect(instance).to.include({ id: 2 });

    const instance2 = DI.get(Array.ofType('Test'));
    expect(instance2.length).to.eq(1);
  });

  it('Should register asMapValue', () => {
    DI.register({ id: 1 }).asMapValue('Test', '1');

    const instance = DI.get<Map<string, any>>('Test');
    expect(instance.get('1')).to.include({ id: 1 });
  });

  it('Should register multiple asMapValue', () => {
    DI.register({ id: 1 }).asMapValue('Test', '1');
    DI.register({ id: 2 }).asMapValue('Test', '2');

    const instance = DI.get<Map<string, any>>('Test');
    expect(instance.get('1')).to.include({ id: 1 });
    expect(instance.get('2')).to.include({ id: 2 });
  });

  it('Should resolve per name', () => {
    @PerInstanceCheck()
    class A implements IInstanceCheck {
      constructor(public Name: string) {}
      __checkInstance__(creationOptions: any): boolean {
        return this.Name === creationOptions[0];
      }
    }

    const a = DI.resolve(A, ['foo']);
    const b = DI.resolve(A, ['foo']);
    const c = DI.resolve(A, ['bar']);

    expect(a).to.be.not.null;
    expect(b).to.be.not.null;
    expect(c).to.be.not.null;

    expect(a == b).to.be.true;
    expect(a == c).to.be.false;
    expect(b == c).to.be.false;
  });

  it('Sould emit on registering value', () => {
    const baseMock = mock();

    DI.once('di.registered.test', baseMock);

    DI.register({ Hello: 'world' }).asValue('test');

    expect(baseMock.calledOnce).to.be.true;
  });

  it('should emit event on resolve', () => {
    const baseMock = mock();
    const targetMock = mock();

    class TestClassBase {}
    @Injectable(TestClassBase)
    class TestClass {}

    DI.once('di.resolved.TestClass', targetMock);
    DI.once('di.resolved.TestClassBase', baseMock);

    DI.resolve(TestClassBase);

    expect(targetMock.calledOnce).to.be.true;
    expect(baseMock.calledOnce).to.be.true;

    DI.resolve(TestClass);
    expect(targetMock.calledOnce).to.be.true;
  });

  it('Should emit event on resolve @NewInstance strategy', () => {
    const baseMock = mock().atLeast(1);
    const targetMock = mock().atLeast(1);

    class TestClassBase {}
    @Injectable(TestClassBase)
    @NewInstance()
    class TestClass {}

    DI.on('di.resolved.TestClass', targetMock);
    DI.on('di.resolved.TestClassBase', baseMock);

    DI.resolve(TestClassBase);
    DI.resolve(TestClassBase);
    DI.resolve(TestClassBase);

    expect(targetMock.callCount).to.eq(3);
    expect(baseMock.callCount).to.eq(3);

    DI.resolve(TestClass);
    expect(targetMock.callCount).to.eq(4);
  });

  it('Should dispose sync service', async () => {
    @Singleton()
    class Foo extends SyncService {}

    const dispose = spy(Foo.prototype, 'dispose');

    DI.resolve(Foo);
    await DI.dispose();

    expect(dispose.calledOnce).to.be.true;
  });

  it('Should dispose async service', async () => {
    @Singleton()
    class Foo extends AsyncService {}

    const dispose = spy(Foo.prototype, 'dispose');

    await DI.resolve(Foo);
    await DI.dispose();

    expect(dispose.calledOnce).to.be.true;
  });

  it('Should emit event on dispose', async () => {
    const dispose = mock();

    DI.on('di.dispose', dispose);
    await DI.dispose();

    expect(dispose.calledOnce).to.be.true;
  });

  it('Should autoinject only once on multiple inheritance', () => {
    const c = DI.resolve(D);
    expect(c).to.be.not.null;
    expect(A.Counter).equal(1);
  });
});
