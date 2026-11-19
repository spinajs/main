import 'mocha';
import { expect } from 'chai';

import { BindException, DI, Injectable, Singleton } from '../src/index.js';

abstract class AuthzClock {
  public abstract now(): Date;
}

abstract class ControllerClock {
  public abstract now(): number;
}

const loadCopiedClock = (copy: string): Promise<typeof import('./fixtures/copied-clock.js')> => import(`./fixtures/copied-clock.js?${copy}`);

describe('two classes with one name', () => {
  afterEach(() => {
    DI.clearCache();
    DI.clearRegistry();
  });

  it('are refused at registration, even under different bases', () => {
    @Singleton()
    @Injectable(AuthzClock)
    class SystemClock extends AuthzClock {
      public now() {
        return new Date();
      }
    }

    expect(DI.resolve(AuthzClock)).to.be.instanceOf(SystemClock);

    expect(() => {
      @Injectable(ControllerClock)
      class SystemClock extends ControllerClock {
        public now() {
          return Date.now();
        }
      }

      return SystemClock;
    }).to.throw(BindException);

    expect(DI.resolve(AuthzClock)).to.be.instanceOf(SystemClock);
  });

  it('are refused under one base, and the error names both classes and the way to replace one', () => {
    class Clock {}
    class SystemClock extends Clock {}
    DI.register(SystemClock).as(Clock);

    const other = (() => {
      class SystemClock {}
      return SystemClock;
    })();

    expect(() => DI.register(other).as(Clock))
      .to.throw(BindException)
      .with.property('message')
      .that.includes('registered as Clock')
      .and.includes('registered: class SystemClock extends Clock; refused: class SystemClock)')
      .and.includes('DI.register(NewSystemClock).as(SystemClock)');
  });

  it('with one declaration head, the error shows the first line where the two classes differ', () => {
    class Clock {}
    class SystemClock extends Clock {
      public zone() {
        return 'UTC';
      }
    }
    DI.register(SystemClock).as(Clock);

    const other = (() => {
      class SystemClock extends Clock {
        public zone() {
          return 'Europe/Warsaw';
        }
      }
      return SystemClock;
    })();

    expect(() => DI.register(other).as(Clock))
      .to.throw(BindException)
      .with.property('message')
      .that.includes('both class SystemClock extends Clock, they differ at line')
      .and.includes(`registered has "return 'UTC';"`)
      .and.includes(`refused has "return 'Europe/Warsaw';"`);
  });

  it('the declaration head in the error keeps a heritage clause with braces', () => {
    const withZone = <T extends new (...args: any[]) => object>(base: T, _options: { zone: string }) => class extends base {};
    class Clock {}
    class SystemClock extends withZone(Clock, { zone: 'UTC' }) {}
    DI.register(SystemClock).as(Clock);

    const other = (() => {
      class SystemClock {}
      return SystemClock;
    })();

    expect(() => DI.register(other).as(Clock))
      .to.throw(BindException)
      .with.property('message')
      .that.includes("registered: class SystemClock extends withZone(Clock, { zone: 'UTC' });");
  });

  it('a bracket inside a string of the heritage clause does not put the whole class into the error', () => {
    const named = <T extends new (...args: any[]) => object>(base: T, _label: string) => class extends base {};
    class Clock {}
    class SystemClock extends named(Clock, ')') {
      public secret = 'SECRET-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789';
      public token = 'TOKEN-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789';
      public key = 'KEY-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789';
    }
    DI.register(SystemClock).as(Clock);

    const other = (() => {
      class SystemClock {}
      return SystemClock;
    })();

    expect(() => DI.register(other).as(Clock))
      .to.throw(BindException)
      .with.property('message')
      .that.has.length.below(400);
    expect(() => DI.register(other).as(Clock))
      .to.throw(BindException)
      .with.property('message')
      .that.does.not.include('SECRET-');
  });

  it('are refused under a typed-array key, which is the key of its element class', () => {
    class Clock {}
    class SystemClock extends Clock {}
    class NtpClock extends Clock {}
    DI.register(SystemClock).as(Clock);

    const other = (() => {
      class SystemClock {}
      return SystemClock;
    })();

    expect(() => DI.RootContainer.Registry.register(Array.ofType(Clock), other)).to.throw(BindException);

    DI.RootContainer.Registry.register(Array.ofType(Clock), NtpClock);
    expect(DI.resolve(Array.ofType(Clock)).map((c) => c.constructor)).to.deep.equal([SystemClock, NtpClock]);
  });

  it('a child container may register a class with the name of its parent class', () => {
    class Clock {}
    class SystemClock extends Clock {}
    DI.register(SystemClock).as(Clock);

    const ChildSystemClock = (() => {
      class SystemClock extends Clock {
        public scoped = true;
      }
      return SystemClock;
    })();

    const child = DI.child();
    expect(() => child.register(ChildSystemClock).as(Clock)).to.not.throw();

    expect(child.resolve(Clock)).to.be.instanceOf(ChildSystemClock);
    expect(DI.resolve(Clock)).to.be.instanceOf(SystemClock);
  });

  it('two different classes with identical source are taken for one class loaded twice', () => {
    const declare = () => {
      class Repository {}
      return Repository;
    };
    const [first, second] = [declare(), declare()];

    DI.register(first).asSelf();
    expect(() => DI.register(second).asSelf()).to.not.throw();

    expect(DI.getRegisteredTypes(first)).to.deep.equal([first]);
  });

  it('a class registered under another name replaces the one it is registered as', () => {
    class Clock {}

    @Injectable(Clock)
    class SystemClock extends Clock {}

    class NewSystemClock extends SystemClock {}
    DI.register(NewSystemClock).as(SystemClock);

    expect(DI.resolve(SystemClock)).to.be.instanceOf(NewSystemClock);
    expect(DI.resolve(Clock)).to.be.instanceOf(NewSystemClock);
  });

  it('one class registered twice stays registered once', () => {
    class Clock {}
    class SystemClock extends Clock {}

    DI.register(SystemClock).as(Clock);
    DI.register(SystemClock).as(Clock);

    expect(DI.getRegisteredTypes(Clock)).to.deep.equal([SystemClock]);
  });

  it('a second copy of the same module is accepted and resolves to the first copy', async () => {
    const first = await loadCopiedClock('first');
    const second = await loadCopiedClock('second');

    expect(second.SystemCopiedClock).to.not.equal(first.SystemCopiedClock);
    expect(DI.resolve(second.CopiedClock)).to.be.instanceOf(first.SystemCopiedClock);
    expect(DI.getRegisteredTypes(second.SystemCopiedClock)).to.deep.equal([first.SystemCopiedClock]);
  });
});
