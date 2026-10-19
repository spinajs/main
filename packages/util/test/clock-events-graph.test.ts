import { expect } from 'chai';
import { Clock, ListenerSet, ManualClock, SystemClock, findCycle, reachable } from '../src/index.js';

const turn = () => new Promise<void>((r) => setImmediate(r));

describe('Clock', () => {
  it('SystemClock tells the wall time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).to.be.within(before, Date.now());
  });

  it('ManualClock moves only when told to', () => {
    const clock = new ManualClock(new Date(1000));
    expect(clock.now().getTime()).to.eq(1000);
    expect(clock.advance(500).now().getTime()).to.eq(1500);
    expect(clock.set(new Date(10)).now().getTime()).to.eq(10);
    expect(new ManualClock().now().getTime()).to.eq(0);
  });

  it('a ManualClock date cannot move the clock', () => {
    const clock = new ManualClock(new Date(1000));
    clock.now().setTime(5);
    expect(clock.now().getTime()).to.eq(1000);
  });

  it('both are Clocks', () => {
    expect(new SystemClock()).to.be.instanceOf(Clock);
    expect(new ManualClock()).to.be.instanceOf(Clock);
  });
});

describe('ListenerSet', () => {
  it('delivers to every listener in order and unsubscribes', () => {
    const set = new ListenerSet<number>();
    const log: string[] = [];
    const offA = set.add((v) => log.push(`a${v}`));
    set.add((v) => log.push(`b${v}`));
    set.emit(1);
    offA();
    offA();
    set.emit(2);
    expect(log).to.deep.eq(['a1', 'b1', 'b2']);
    expect(set.size).to.eq(1);
  });

  it('keeps two subscriptions of one function independent', () => {
    const set = new ListenerSet<number>();
    let calls = 0;
    const fn = () => calls++;
    const off = set.add(fn);
    set.add(fn);
    off();
    set.emit(0);
    expect(calls).to.eq(1);
  });

  it('isolates a throwing and a rejecting listener', async () => {
    const errors: unknown[] = [];
    const set = new ListenerSet<number>((err) => errors.push(err));
    const log: number[] = [];
    set.add(() => {
      throw new Error('sync');
    });
    set.add(() => Promise.reject(new Error('async')));
    set.add((v) => log.push(v));
    set.emit(7);
    await turn();
    expect(log).to.deep.eq([7]);
    expect(errors.map((e) => (e as Error).message)).to.deep.eq(['sync', 'async']);
  });

  it('delivers to the listeners present when emit started', () => {
    const set = new ListenerSet<number>();
    const log: string[] = [];
    let offB: () => void = () => undefined;
    set.add(() => {
      log.push('a');
      offB();
      set.add(() => log.push('late'));
    });
    offB = set.add(() => log.push('b'));
    set.emit(0);
    expect(log).to.deep.eq(['a', 'b']);
  });

  it('clear removes every listener', () => {
    const set = new ListenerSet<number>();
    set.add(() => undefined);
    set.clear();
    expect(set.size).to.eq(0);
  });
});

describe('graph', () => {
  const graph = (edges: Record<string, string[]>) => (n: string) => edges[n] ?? [];

  describe('findCycle', () => {
    it('answers undefined for an acyclic graph', () => {
      const edges = graph({ a: ['b', 'c'], b: ['c'], c: [] });
      expect(findCycle(['a', 'b', 'c'], edges)).to.be.undefined;
    });

    it('returns the closed path of the first cycle met', () => {
      const edges = graph({ a: ['b'], b: ['c'], c: ['d', 'b'], d: [] });
      expect(findCycle(['a', 'b', 'c', 'd'], edges)).to.deep.eq({ nodes: ['b', 'c', 'b'], edges: ['c', 'b'] });
    });

    it('finds a self loop', () => {
      expect(findCycle(['x'], graph({ x: ['x'] }))).to.deep.eq({ nodes: ['x', 'x'], edges: ['x'] });
    });

    it('returns the edges taken, with targetOf', () => {
      type Edge = { to: string; via: string };
      const out: Record<string, Edge[]> = {
        admin: [{ to: 'editor', via: 'extends' }],
        editor: [{ to: 'viewer', via: 'ladder' }],
        viewer: [{ to: 'admin', via: 'implies' }],
      };
      const cycle = findCycle(Object.keys(out), (n) => out[n], (e: Edge) => e.to);
      expect(cycle?.nodes).to.deep.eq(['admin', 'editor', 'viewer', 'admin']);
      expect(cycle?.edges.map((e) => e.via)).to.deep.eq(['extends', 'ladder', 'implies']);
    });

    it('does not overflow the stack on a deep graph', () => {
      const n = 100_000;
      const edgesOf = (i: number) => (i < n ? [i + 1] : [0]);
      const cycle = findCycle([0], edgesOf);
      expect(cycle?.nodes.length).to.eq(n + 2);
    });
  });

  describe('reachable', () => {
    it('lists the start and every reachable node in breadth-first order', () => {
      const edges = graph({ a: ['b', 'c'], b: ['d'], c: ['d', 'a'], d: [], e: ['a'] });
      expect(reachable('a', edges)).to.deep.eq(['a', 'b', 'c', 'd']);
      expect(reachable('d', edges)).to.deep.eq(['d']);
    });

    it('follows targetOf', () => {
      const out: Record<string, { to: string }[]> = { a: [{ to: 'b' }], b: [] };
      expect(reachable('a', (n) => out[n], (e) => e.to)).to.deep.eq(['a', 'b']);
    });
  });
});
