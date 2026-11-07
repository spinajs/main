import 'mocha';
import { expect } from 'chai';
import { AsyncService, Container } from '../src/index.js';

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

abstract class Stage extends AsyncService {}

class SlowStage extends Stage {
  public async resolve() {
    await delay(30);
  }
}

class MidStage extends Stage {
  public async resolve() {
    await delay(10);
  }
}

class FastStage extends Stage {
  public async resolve() {
    await Promise.resolve();
  }
}

class SyncPlugin {}

const names = (items: unknown[]) => items.map((i) => (i as object).constructor.name);

function stages(...types: (typeof SlowStage)[]) {
  const c = new Container();
  for (const t of types) {
    c.register(t).as(Stage);
  }
  return c;
}

describe('Array.ofType order', () => {
  it('returns elements in registration order, not in the order their creation finished', async () => {
    const c = stages(SlowStage, MidStage, FastStage);

    const all = await c.resolve(Array.ofType(Stage));

    expect(names(all)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
  });

  it('keeps registration order on the cached collection', async () => {
    const c = stages(SlowStage, FastStage);
    await c.resolve(Array.ofType(Stage));

    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
    expect(names(c.get(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'FastStage']);
  });

  it('puts a sync element registered after an async one after it', async () => {
    const c = new Container();
    c.register(SlowStage).as('Plugins');
    c.register(SyncPlugin).as('Plugins');

    expect(names(await c.resolve(Array.ofType('Plugins')))).to.deep.equal(['SlowStage', 'SyncPlugin']);
  });

  it('places an element registered after the first build last', async () => {
    const c = stages(SlowStage, MidStage);
    await c.resolve(Array.ofType(Stage));
    c.register(FastStage).as(Stage);

    expect(names(await c.resolve(Array.ofType(Stage)))).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
  });

  it('places an element resolved on its own before the list in its registration slot', async () => {
    const c = stages(SlowStage, MidStage, FastStage);
    const fast = await c.resolve(FastStage);

    const all = await c.resolve(Array.ofType(Stage));

    expect(names(all)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(all[2]).to.equal(fast);
  });

  it('gives two concurrent list resolves the same ordered list', async () => {
    const c = stages(SlowStage, MidStage, FastStage);

    const [a, b] = await Promise.all([c.resolve(Array.ofType(Stage)), c.resolve(Array.ofType(Stage))]);

    expect(names(a)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(names(b)).to.deep.equal(['SlowStage', 'MidStage', 'FastStage']);
    expect(a.every((x, i) => x === b[i])).to.be.true;
  });
});

describe('Array.ofType and a concurrent single resolve', () => {
  it('a single resolve while the list is creating that type gets the instance, not the list', async () => {
    const c = stages(SlowStage, FastStage);

    const list = c.resolve(Array.ofType(Stage));
    const one = c.resolve(SlowStage);

    const [all, slow] = await Promise.all([list, one]);

    expect(slow).to.be.instanceOf(SlowStage);
    expect(all[0]).to.equal(slow);
  });

  it('a single resolve of the base while the list is creating its last registration gets that instance', async () => {
    const c = stages(FastStage, SlowStage);

    const list = c.resolve(Array.ofType(Stage));
    const one = c.resolve(Stage);

    const [all, last] = await Promise.all([list, one]);

    expect(last).to.be.instanceOf(SlowStage);
    expect(all[1]).to.equal(last);
  });

  it('a list resolve while a single resolve is creating an element still contains that element', async () => {
    const c = stages(SlowStage, FastStage);

    const one = c.resolve(SlowStage);
    const list = c.resolve(Array.ofType(Stage));

    const [slow, all] = await Promise.all([one, list]);

    expect(names(all)).to.deep.equal(['SlowStage', 'FastStage']);
    expect(all[0]).to.equal(slow);
  });
});
