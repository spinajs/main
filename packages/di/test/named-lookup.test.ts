import 'mocha';
import { expect } from 'chai';

import { AsyncService, DI, PerChildInstance, ServiceNotFound, Singleton } from '../src/index.js';
import type { IContainer } from '../src/index.js';

abstract class Step {
  public abstract readonly label: string;
}

@Singleton()
class RootStep extends Step {
  public readonly label = 'root';
}

class OtherStep extends Step {
  public readonly label = 'other';
}

@PerChildInstance()
class PerChildStep extends Step {
  public readonly label = 'per child';
}

class ResolvedStep extends AsyncService {
  public resolvedIn: string | undefined;
  public async resolve(): Promise<void> {
    this.resolvedIn = 'resolve()';
    await super.resolve();
  }
}

function named<T>(name: string, make: (c: IContainer) => T): (c: IContainer) => T {
  const factory = (c: IContainer) => make(c);
  Object.defineProperty(factory, 'name', { value: name });
  return factory;
}

describe('named lookup across the container lineage', () => {
  beforeEach(() => {
    DI.clear();
  });

  describe('getRegisteredNames', () => {
    it('lists the names of the lineage, ancestors first, without repeats', () => {
      DI.register(RootStep).as(Step);
      DI.register(named('Fake', () => ({ label: 'fake' }))).as(Step);
      const child = DI.child();
      child.register(OtherStep).as(Step);
      child.register(named('Fake', () => ({ label: 'child fake' }))).as(Step);

      expect(child.getRegisteredNames(Step)).to.deep.equal(['RootStep', 'Fake', 'OtherStep']);
      expect(DI.RootContainer.getRegisteredNames(Step)).to.deep.equal(['RootStep', 'Fake']);
    });

    it('is empty when nothing is registered', () => {
      expect(DI.child().getRegisteredNames(Step)).to.deep.equal([]);
    });

    it('leaves out an anonymous factory', () => {
      DI.register(RootStep).as(Step);
      const anonymous = [() => ({ label: 'x' })][0];
      DI.register(anonymous).as(Step);

      expect(DI.RootContainer.getRegisteredNames(Step)).to.deep.equal(['RootStep']);
    });
  });

  describe('resolveNamed', () => {
    it('calls a factory named through Object.defineProperty with the resolving container', async () => {
      const seen: IContainer[] = [];
      DI.register(
        named('Fake', (c) => {
          seen.push(c);
          return { label: 'fake' };
        }),
      ).as(Step);
      const child = DI.child();

      expect(await child.resolveNamed(Step, 'Fake')).to.deep.equal({ label: 'fake' });
      expect(seen).to.deep.equal([child]);
    });

    it('resolves a class through DI, so its lifetime applies', async () => {
      DI.register(RootStep).as(Step);
      const child = DI.child();

      const step = await child.resolveNamed(Step, 'RootStep');
      expect(step).to.be.instanceOf(RootStep);
      expect(await DI.RootContainer.resolveNamed(Step, 'RootStep')).to.equal(step);
    });

    it('resolves a PerChildContainer class in the resolving container', async () => {
      DI.register(PerChildStep).as(Step);
      const first = DI.child();
      const second = DI.child();

      const step = await first.resolveNamed(Step, 'PerChildStep');
      expect(step).to.be.instanceOf(PerChildStep);
      expect(await first.resolveNamed(Step, 'PerChildStep')).to.equal(step);
      expect(await second.resolveNamed(Step, 'PerChildStep')).to.not.equal(step);
    });

    it('waits for an AsyncService to resolve', async () => {
      DI.register(ResolvedStep).as(Step);

      const step = (await DI.RootContainer.resolveNamed(Step, 'ResolvedStep')) as unknown as ResolvedStep;
      expect(step.resolvedIn).to.equal('resolve()');
    });

    it('takes the registration nearest to the resolving container', async () => {
      DI.register(named('Fake', () => ({ label: 'root' }))).as(Step);
      const child = DI.child();
      child.register(named('Fake', () => ({ label: 'child' }))).as(Step);
      const grandchild = child.child();

      expect(await grandchild.resolveNamed(Step, 'Fake')).to.deep.equal({ label: 'child' });
      expect(await DI.RootContainer.resolveNamed(Step, 'Fake')).to.deep.equal({ label: 'root' });
    });

    it('finds an ancestor registration next to the child registrations', async () => {
      DI.register(RootStep).as(Step);
      const child = DI.child();
      child.register(OtherStep).as(Step);

      expect(await child.resolveNamed(Step, 'RootStep')).to.be.instanceOf(RootStep);
      expect(await child.resolveNamed(Step, 'OtherStep')).to.be.instanceOf(OtherStep);
    });

    it('throws ServiceNotFound for an unknown name', async () => {
      DI.register(RootStep).as(Step);

      for (const [base, name] of [
        [Step, 'Missing'],
        [OtherStep, 'RootStep'],
      ] as const) {
        const error = await DI.child()
          .resolveNamed(base, name)
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(error).to.be.instanceOf(ServiceNotFound);
        expect((error as Error).message).to.equal(`No ${base.name} is registered as "${name}"`);
      }
    });

    it('gives what a factory returns, undefined included', async () => {
      DI.register(named('Nothing', () => undefined)).as(Step);

      expect(await DI.RootContainer.resolveNamed(Step, 'Nothing')).to.equal(undefined);
    });
  });
});
