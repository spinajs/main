import { InvalidArgument } from '@spinajs/exceptions'
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncModule, Autoinject, Container, DI, Inject, Injectable, LazyInject, NewInstance, PerChildInstance, SyncModule, Singleton, ResolveException } from '../src';

const expect = chai.expect;
chai.use(chaiAsPromised);

class NoRegisteredType
{

}

@Singleton()
// @ts-ignore
class Foo {
    public static Counter: number;

    public static initialize() {
        Foo.Counter = 0;
    }

    constructor() {
        Foo.Counter++;
    }
}

Foo.initialize();

@NewInstance()
// @ts-ignore
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
    // @ts-ignore
    public Foo: Foo;
}
@NewInstance()
// @ts-ignore
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
// @ts-ignore
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


class Zar {

}



class AutoinjectBar {

}

class AutoinjectClass {

    @Autoinject()
    // @ts-ignore
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
    // @ts-ignore
    public Instance: LazyInjectDep;
}

abstract class SampleBaseClass {
    public Name: string;
}

class SampleImplementation1 extends SampleBaseClass {

    constructor() {
        super();

        this.Name = "Sample1";
    }
}

class SampleImplementation2 extends SampleBaseClass {
    constructor() {
        super();

        this.Name = "Sample2";
    }
}



@Singleton()
// @ts-ignore
class TestModule extends SyncModule {
    public Initialized = false;

    // tslint:disable-next-line: no-empty
    public resolve() {
        this.Initialized = true;
    }
}



@Inject(Container)
// @ts-ignore
class TestInjectContainerAsParameter {

    constructor(public container: Container) {

    }
}

class TestInjectContainerAsProperty {

    @Autoinject()
    // @ts-ignore
    public container: Container;
}


class BaseInject {

}

@Inject(BaseInject)
// @ts-ignore
class BaseClass {
    constructor(public baseInject: BaseInject) { }
}

class ChildClass extends BaseClass {

}


describe("Dependency injection", () => {
    beforeEach(() => {
        DI.clear();
    })

    it("Inject container", () => {
        const root = DI.RootContainer;
        const instance = DI.resolve<TestInjectContainerAsParameter>(TestInjectContainerAsParameter);
        const instance2 = DI.resolve<TestInjectContainerAsProperty>(TestInjectContainerAsProperty);
        expect(instance.container === root).to.be.true;
        expect(instance2.container === root).to.be.true;
    })

    it("Injectable should register class", () => {

        @Injectable()
        // @ts-ignore
        class InjectableTest {

        }

        const registry = DI.RootContainer.Registry;

        expect(registry).to.be.an("Map").that.have.length(1);
        expect(registry.get(InjectableTest.name)).to.be.an("array").that.have.length(1);
        expect(registry.get(InjectableTest.name)[0]).to.be.not.null;
        expect(DI.resolve(InjectableTest)).to.be.not.null;
    })

    it("Injectable should register class as another", () => {

        class InjectableBase {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest {

        }



        const registry = DI.RootContainer.Registry;

        expect(registry).to.be.an("Map").that.have.length(1);
        expect(registry.get(InjectableBase.name)).to.be.an("array").that.have.length(1);
        expect(registry.get(InjectableBase.name)[0]).to.be.not.null;
        expect(registry.get(InjectableBase.name)[0].name).to.eq("InjectableTest");
        expect(DI.resolve(InjectableBase)).to.be.instanceOf(InjectableTest)

    })

    it("Injectable should register multiple class as another", () => {

        class InjectableBase {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest2 {

        }



        const registry = DI.RootContainer.Registry;

        expect(registry).to.be.an("Map").that.have.length(1);
        expect(registry.get(InjectableBase.name)).to.be.an("array").that.have.length(2);
        expect(registry.get(InjectableBase.name)[0]).to.be.not.null;
        expect(registry.get(InjectableBase.name)[0].name).to.eq("InjectableTest");

        const services = DI.resolve(Array.ofType(InjectableBase));
        expect(services).to.be.an("array").that.have.length(2);
        expect(services[0]).to.be.instanceOf(InjectableTest);
        expect(services[1]).to.be.instanceOf(InjectableTest2);
    })


    it("Inject child container", () => {
        const child = DI.child();
        const instance = child.resolve<TestInjectContainerAsParameter>(TestInjectContainerAsParameter);
        const instance2 = child.resolve<TestInjectContainerAsProperty>(TestInjectContainerAsProperty);
        const root = DI.RootContainer;
        expect(instance.container === root).to.be.false;
        expect(instance2.container === root).to.be.false;
        expect(instance.container === child).to.be.true;
        expect(instance2.container === child).to.be.true;
    })

    it("Should inject on base class declaration", () => {
        const instance = DI.resolve<ChildClass>(ChildClass);
        expect(instance.baseInject).to.be.not.null;
        expect(instance.baseInject instanceof BaseInject).to.be.true;
    });

    it("Framework module initialization strategy", () => {
        const module = DI.resolve<TestModule>(TestModule);

        expect(module).to.be.not.null;
        expect(module.Initialized).to.be.true;
    })

    it("Register multiple classes with same base class", () => {
        DI.register(SampleImplementation1).as(SampleBaseClass);
        DI.register(SampleImplementation2).as(SampleBaseClass);

        const val = DI.resolve(Array.ofType(SampleBaseClass));
        expect(val).to.be.not.null;
        expect(val.length).to.eq(2);
        expect(val[0] instanceof SampleImplementation1).to.be.true;
        expect(val[1] instanceof SampleImplementation2).to.be.true;


    });

    it("Autoinject resolve", () => {

        const autoinjected = DI.resolve<AutoinjectClass>(AutoinjectClass);

        expect(autoinjected).to.be.not.null;
        expect(autoinjected.Test).to.be.not.null;
        expect(autoinjected.Test instanceof AutoinjectBar).to.be.true;
    })

    it("Autoinject resolve multiple implementations", () => {

        DI.register(SampleImplementation1).as(SampleBaseClass);
        DI.register(SampleImplementation2).as(SampleBaseClass);


        class SampleMultipleAutoinject {

            @Autoinject(SampleBaseClass)
            // @ts-ignore
            public Instances: SampleBaseClass[];
        }

        const instance = DI.resolve(SampleMultipleAutoinject);

        expect(instance).to.be.not.null;
        expect(instance.Instances).to.be.an("array").of.length(2);
    })

    it("Should autoinject multiple as singleton", async () => {

        @Singleton()
        // @ts-ignore
        class SampleImplementation1Single extends SampleBaseClass {

            public static CallCount = 0;
            constructor() {
                super();

                this.Name = "Sample1";

                SampleImplementation1Single.CallCount++;
            }
        }

        @Singleton()
        // @ts-ignore
        class SampleImplementation2Single extends SampleBaseClass {

            public static CallCount = 0;

            constructor() {
                super();

                this.Name = "Sample2";

                SampleImplementation2Single.CallCount++;

            }
        }


        DI.register(SampleImplementation1Single).as(SampleBaseClass);
        DI.register(SampleImplementation2Single).as(SampleBaseClass);
        class SampleMultipleAutoinject {

            @Autoinject(SampleBaseClass)
            // @ts-ignore
            public Instances: SampleBaseClass[];
        }

        class SampleMultiple2Autoinject {

            @Autoinject(SampleBaseClass)
            // @ts-ignore
            public Instances: SampleBaseClass[];
        }

        const instance = DI.resolve(SampleMultipleAutoinject);
        const instance2 = DI.resolve(SampleMultiple2Autoinject);

        expect(instance2).to.be.not.null;
        expect(instance).to.be.not.null;
        expect(instance.Instances).to.be.an("array").of.length(2);
        expect(SampleImplementation1Single.CallCount).to.equal(1);
        expect(SampleImplementation2Single.CallCount).to.equal(1);


    });

    it("Lazy inject check", () => {

        const lazyinject = DI.resolve<LazyInjectResolve>(LazyInjectResolve);

        expect(LazyInjectDep.Counter).to.eq(0);

        const dep = lazyinject.Instance;
        expect(dep).to.be.instanceof(LazyInjectDep);

    })

    it("Singleton creation", () => {

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
            expect((single === single3 && single === single4)).to.equal(true);

            // second level child
            {
                const child2 = child.child();
                const single5 = child2.resolve<Foo>(Foo);
                const single6 = child2.resolve<Foo>(Foo);

                expect(Foo.Counter).to.eq(1);
                expect((single === single5 && single === single6)).to.equal(true);
            }
        }
    })

    it("New instance creation", () => {
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
    })

    it("New instance creation with inheritance", () => {
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
    })

    it("Per child container creation", () => {

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

    it("Register type as self", () => {
        DI.register(Zar).asSelf();

        const zar = DI.resolve(Zar);
        expect(zar).to.be.not.null;
        expect(zar.constructor.name).to.equal(Zar.name);
    })

    it("Register type as implementation of another", () => {
        class RegisterBase { }
        class RegisterImpl implements RegisterBase { }

        DI.register(RegisterImpl).as(RegisterBase);

        const instance = DI.resolve(RegisterBase);
        expect(instance).to.be.not.null;
        expect(instance.constructor.name).to.equal(RegisterImpl.name);
    })

    it("Register type as singleton", () => {
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
    })

    it("Should resolve async", async () => {

        DI.clear();

        class Test extends AsyncModule {

            public Initialized = false;

            public async resolveAsync() {
                return new Promise<void>((res) => {
                    setTimeout(() => {
                        this.Initialized = true;
                        res();
                    }, 200);
                })
            }
        }

        const instance = await DI.resolve(Test);

        expect(instance instanceof Test).to.be.true;
        expect(DI.get("Test")).to.be.not.null;
        expect(instance.Initialized).to.be.true;
    })

    it("Should resolve sync", async () => {

        DI.clear();

        class Test extends SyncModule {

            public Initialized = false;

            public async resolve() {
                this.Initialized = true;
            }
        }

        const instance = await DI.resolve(Test);

        expect(instance instanceof Test).to.be.true;
        expect(DI.get("Test")).to.be.not.null;
        expect(instance.Initialized).to.be.true;
    })

    it("Should clear container", () => {
        class Test { }

        DI.resolve(Test);
        expect(DI.get("Test")).to.be.not.null;
        DI.clear();
        expect(DI.get("Test")).to.be.null;
    })

    it("Should get if type is already resolved", () => {
        class Test { }

        DI.resolve(Test);

        expect(DI.get("Test")).to.be.not.null;
    })

    it("Get should return null if type is not already resolved", () => {
        expect(DI.get("Test")).to.be.null;
    })

    it("Should throw if type is unknown", () => {
        return expect(() => DI.resolve(undefined)).to.throw(InvalidArgument, "argument `type` cannot be null or undefined");
    })

    it("Should resolve from factory func", () => {
        class IDatabase { }

        class DatabaseImpl implements IDatabase { }

        DI.register((container: Container, connString: string) => {
            expect(container).to.be.not.null;
            expect(container.constructor.name).to.eq("Container");
            expect(connString).to.eq("root@localhost");
            return new DatabaseImpl();
        }).as(IDatabase);

        const instance = DI.resolve<IDatabase>(IDatabase, ["root@localhost"]);
        expect(instance).to.be.not.null;
        expect(instance.constructor.name).to.eq("DatabaseImpl");
    })

    it("Should resolve from factory func with no args", () => {
        class IDatabase { }

        class DatabaseImpl implements IDatabase { }

        DI.register((container: Container) => {
            expect(container).to.be.not.null;
            expect(container.constructor.name).to.eq("Container");
            return new DatabaseImpl();
        }).as(IDatabase).singleInstance();

        const instance = DI.resolve<IDatabase>(IDatabase);
        expect(instance).to.be.not.null;
        expect(instance.constructor.name).to.eq("DatabaseImpl");
    })

    it("Should resolve from factory as different objects", () => {
        class IDatabase { }

        class DatabaseImpl implements IDatabase { }

         
        const factory = (container: Container) => {
            expect(container).to.be.not.null;
            expect(container.constructor.name).to.eq("Container");
            return new DatabaseImpl();
        }

        DI.register(factory).as(IDatabase);

        const instance = DI.resolve<IDatabase>(IDatabase);
        const instance2 = DI.resolve<IDatabase>(IDatabase);

        expect(instance).to.be.not.null;
        expect(instance.constructor.name).to.eq("DatabaseImpl");
        expect(instance2 !== instance).to.be.true;
    })

    it("Should inject options at resolve", () => {
        class Bar { }

        @Inject(Bar)
        // @ts-ignore
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

        const instance = DI.resolve<Test>(Test, ["a", 1]);
        expect(instance.A).to.eq("a");
        expect(instance.B).to.eq(1);
        expect(instance.Bar).to.be.not.null;
        expect(instance.Bar.constructor.name).to.be.eq("Bar");
    });

    it("Should construct child container", () => {
        const child = DI.RootContainer.child();
        expect(child).to.be.not.null;
    });

    it("Should check if registered", () => {
        @Injectable()
        // @ts-ignore
        class FooBar { }

        class ZarFar { }

        expect(DI.check(FooBar)).to.eq(true);
        expect(DI.check(ZarFar)).to.eq(false);
    })

    it("Should check if registered with parent", () => {

        @Injectable()
        // @ts-ignore
        class FooBar { }

        class ZarFar { }

        {
            const child = DI.child();

            expect(child.hasRegistered(FooBar, true)).to.eq(true);
            expect(child.hasRegistered(FooBar, false)).to.eq(false);

            expect(child.hasRegistered(ZarFar, true)).to.eq(false);
            expect(child.hasRegistered(ZarFar, false)).to.eq(false);

        }


    })

    it("Should throw if resolving with check", () => {

        class FooBar { }
        expect(() => {
            DI.resolve(FooBar, true);
        }).to.throw;

    });

    it("Should get All with Array.typeOf", () => {


        class InjectableBase {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest2 {

        }

        DI.resolve(Array.ofType(InjectableBase));

        const getted = DI.get(Array.ofType(InjectableBase));

        expect(getted).to.be.an("array").that.have.length(2);
        expect(getted[0]).to.be.instanceOf(InjectableTest);
        expect(getted[1]).to.be.instanceOf(InjectableTest2);
    })

    it("Should throw when trying to resolve array type", () =>{ 
        expect( () => DI.resolve(Array.ofType(NoRegisteredType))).to.throw(ResolveException);
    })

    it("Should @Inject should resolve all implementations", () => {
        class InjectableBase {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest {

        }

        @Injectable(InjectableBase)
        // @ts-ignore
        class InjectableTest2 {

        }

        @Inject(Array.ofType(InjectableBase))
        // @ts-ignore
        class ResolvableClass {
            public Instances: InjectableBase[];

            constructor(_instances: InjectableBase[]) {
                this.Instances = _instances;
            }
        }

        const instance = DI.resolve(ResolvableClass);

        expect(instance).to.be.not.null;
        expect(instance.Instances).to.be.an("array").of.length(2);
    });

    it("Should throw when resolve with check", () => {

        class BarFart { }

        expect(() => {
            DI.resolve(BarFart, true);
        }).to.throw();

        expect(() => {
            DI.resolve(BarFart, [1], true);
        }).to.throw();

    })

    it("Should register singleton at resolve", () => {

        class PisFart { }

        DI.resolve(PisFart);

        expect(DI.check(PisFart)).to.eq(true);

    })

    it("Should not register at resolve @NewInstance", () => {

        @NewInstance()
        // @ts-ignore
        class POFart { }

        DI.resolve(POFart);

        expect(DI.check(POFart)).to.eq(false);

    })

    it("Should register class with as string name", () => {

        class FuPIS { }

        DI.register(FuPIS).as("FuPIS");

        expect(DI.check("FuPIS")).to.eq(true);

        const instance = DI.resolve("FuPIS");
        expect(instance).to.be.not.null;

    })

    it("should resolve on multiple inheritance with mixed decorators", () => {

        class Foo { };

        class Bar { };

        class A {

            @Autoinject(Foo)
            // @ts-ignore
            public Foo: Foo;
        }

        class B extends A {

        }

        @Inject(Bar)
        // @ts-ignore
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

    })

    it("Resolve with check in registry should look in parent containers", () => {

        class Foo {
            public Count = 1;
        };

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
    })

    it("Resolve should check for resolved services in parent containers", () => {
        class Foo {
        };

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

    it("Should resolve factory function as string", async () => {

        DI.register(() => {
            return { id: 1 };
        }).as("Test").singleInstance();

        const instance = await DI.resolve("Test");
        expect(instance).to.include({ id: 1 });
    })

});

