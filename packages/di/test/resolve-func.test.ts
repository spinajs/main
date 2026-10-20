import 'mocha';
import { expect } from 'chai';

import { AddDependencyForProperty, DI } from '../src/index.js';
import type { IContainer, IInjectDescriptor } from '../src/index.js';

function Computed(make: (data: unknown, container: IContainer) => unknown, data?: unknown) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target, propertyKey) => {
    descriptor.inject.push({ autoinject: true, autoinjectKey: propertyKey, inject: Object, data, resolveFunc: make });
  });
}

const seen: IContainer[] = [];

class SyncHolder {
  @Computed((data, c) => {
    seen.push(c);
    return `value of ${String(data)}`;
  }, 'key')
  public Value: string;
}

class AsyncHolder {
  @Computed(async () => new Map([['a', 1]]))
  public Value: Map<string, number>;
}

class FailingHolder {
  @Computed(async () => {
    throw new Error('no value');
  })
  public Value: unknown;
}

describe('a property dependency with resolveFunc', () => {
  beforeEach(() => {
    DI.clear();
    seen.length = 0;
  });

  it('injects what resolveFunc returns, given the data and the resolving container', () => {
    const child = DI.child();
    const holder = child.resolve(SyncHolder);
    expect(holder.Value).to.equal('value of key');
    expect(seen).to.deep.equal([child]);
  });

  it('waits for a promise resolveFunc returns', async () => {
    const holder = await (DI.resolve(AsyncHolder) as unknown as Promise<AsyncHolder>);
    expect([...holder.Value]).to.deep.equal([['a', 1]]);
  });

  it('rejects the resolve when resolveFunc rejects', async () => {
    const error = await (DI.resolve(FailingHolder) as unknown as Promise<FailingHolder>).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).to.equal('no value');
  });
});
