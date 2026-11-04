import 'mocha';
import { expect } from 'chai';

import { tracingState, withSpan } from '../src/index.js';
import { resetTracing, useInMemorySpans } from '../src/testing.js';
import type { InMemorySpans } from '../src/testing.js';

const noop = async (): Promise<void> => undefined;

describe('useInMemorySpans', () => {
  let spans: InMemorySpans;

  before(() => resetTracing());
  beforeEach(() => {
    spans = useInMemorySpans();
  });
  afterEach(() => spans.detach());
  after(() => resetTracing());

  it('starts tracing when nothing did and returns the finished spans as a tree', async () => {
    expect(tracingState().owner).to.eq('spinajs');
    await withSpan('root', {}, async () => {
      await withSpan('a', {}, () => withSpan('a.1', {}, noop));
      await withSpan('b', {}, noop);
    });

    const tree = spans.tree();
    expect(tree.map((n) => n.span.name)).to.deep.eq(['root']);
    expect(tree[0].children.map((n) => n.span.name)).to.deep.eq(['a', 'b']);
    expect(tree[0].children[0].children.map((n) => n.span.name)).to.deep.eq(['a.1']);
  });

  it('reset() forgets what was collected', async () => {
    await withSpan('x', {}, noop);
    spans.reset();
    expect(spans.spans()).to.deep.eq([]);
  });

  it('waitFor() rejects when no span of that name ends in time', async () => {
    let thrown: unknown;
    try {
      await spans.waitFor('never', 20);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).to.match(/no span named "never"/);
  });
});
