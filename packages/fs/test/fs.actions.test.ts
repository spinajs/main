import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { PassThrough } from 'node:stream';

import { DI } from '@spinajs/di';

import { FsMiddleware, executeFsAction, fsTarget, inFsAction } from '../src/actions.js';
import type { FsActionContext } from '../src/actions.js';
import type { fs } from '../src/interfaces.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const fakeFs = (name: string, basePath?: string): fs =>
  ({
    Name: name,
    BasePath: basePath,
    exists: async () => true,
    dirExists: async () => true,
    isDir: async () => false,
  }) as unknown as fs;

const log: string[] = [];

class First extends FsMiddleware {
  public order = 10;
  async before(ctx: FsActionContext) {
    log.push(`first.before:${ctx.action}:${ctx.targets.map((t) => t.path).join(',')}`);
  }
  async after(_ctx: FsActionContext, result: unknown) {
    log.push('first.after');
    return `${String(result)}+first`;
  }
}

class Second extends FsMiddleware {
  public order = 20;
  isEnabled(target: fs) {
    return target.Name !== 'off';
  }
  async before() {
    log.push('second.before');
  }
}

const run = <R>(owner: fs, impl: () => Promise<R>, extra: Partial<Parameters<typeof executeFsAction>[0]> = {}) =>
  executeFsAction<R>({
    action: 'read',
    owner,
    targets: [fsTarget(owner, { path: '/a/../b.txt', kind: 'file', access: ['read'] })],
    args: [],
    impl: async () => impl(),
    stream: false,
    ...extra,
  } as Parameters<typeof executeFsAction<R>>[0]);

describe('fs actions: engine', () => {
  beforeEach(() => {
    log.length = 0;
    DI.register(Second).as(FsMiddleware);
    DI.register(First).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
  });

  afterEach(() => {
    DI.unregister(First);
    DI.unregister(Second);
    DI.uncache(Array.ofType(FsMiddleware));
  });

  it('normalises target paths against the target fs base path', () => {
    const t = fsTarget(fakeFs('x', '/data/up'), { path: '/data/up/docs/../a.txt', kind: 'file', access: ['read'] });
    expect(t.path).to.equal('a.txt');
    expect(t.role).to.equal('source');
  });

  it('runs before hooks by order, the impl, then after hooks that replace the result', async () => {
    const result = await run(fakeFs('on'), async () => 'io');
    expect(log).to.deep.equal(['first.before:read:b.txt', 'second.before', 'first.after']);
    expect(result).to.equal('io+first');
  });

  it('skips a middleware no target fs enables', async () => {
    await run(fakeFs('off'), async () => 'io');
    expect(log).to.deep.equal(['first.before:read:b.txt', 'first.after']);
  });

  it('runs no IO when a before hook throws', async () => {
    class Deny extends FsMiddleware {
      async before() {
        throw new Error('denied');
      }
    }
    DI.register(Deny).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    let io = false;
    await expect(run(fakeFs('on'), async () => (io = true))).to.be.rejectedWith('denied');
    expect(io).to.equal(false);
    DI.unregister(Deny);
  });

  it('marks the impl as inside an action and skips middlewares for nested calls', async () => {
    const seen: boolean[] = [];
    await run(fakeFs('on'), async () => {
      seen.push(inFsAction());
      await run(fakeFs('on'), async () => 'nested');
      return 'io';
    });
    expect(seen).to.deep.equal([true]);
    expect(log.filter((l) => l.startsWith('first.before'))).to.have.length(1);
    expect(inFsAction()).to.equal(false);
  });

  it('closes the frame when the action settles', async () => {
    let later: Promise<boolean> | undefined;
    await run(fakeFs('on'), async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(inFsAction()), 5));
      return 'io';
    });
    expect(await later).to.equal(false);
  });

  it('memoises ctx.exists per target', async () => {
    let probes = 0;
    const owner = { ...fakeFs('on'), exists: async () => (probes++, false) } as unknown as fs;
    class ProbeExists extends FsMiddleware {
      async before(ctx: FsActionContext) {
        expect(await ctx.exists(ctx.targets[0])).to.equal(false);
        expect(await ctx.exists(ctx.targets[0])).to.equal(false);
      }
    }
    DI.register(ProbeExists).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    await run(owner, async () => 'io');
    expect(probes).to.equal(1);
    DI.unregister(ProbeExists);
  });

  it('memoises ctx.isDir per target and probes inside the frame', async () => {
    let probes = 0;
    const inside: boolean[] = [];
    const owner = { ...fakeFs('on'), isDir: async () => (probes++, inside.push(inFsAction()), true) } as unknown as fs;
    class ProbeDir extends FsMiddleware {
      async before(ctx: FsActionContext) {
        expect(await ctx.isDir(ctx.targets[0])).to.equal(true);
        expect(await ctx.isDir(ctx.targets[0])).to.equal(true);
      }
    }
    DI.register(ProbeDir).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    await run(owner, async () => 'io');
    expect(probes).to.equal(1);
    expect(inside).to.deep.equal([true]);
    DI.unregister(ProbeDir);
  });

  it('memoises ctx.hasEntries per target, asks the target fs inside the frame and propagates its error', async () => {
    let probes = 0;
    const inside: boolean[] = [];
    const listing = (answer: () => boolean) => ({ ...fakeFs('on'), hasEntries: async () => (probes++, inside.push(inFsAction()), answer()) }) as unknown as fs;
    const seen: unknown[] = [];
    class ProbeEntries extends FsMiddleware {
      async before(ctx: FsActionContext) {
        seen.push(await ctx.hasEntries(ctx.targets[0]), await ctx.hasEntries(ctx.targets[0]));
      }
    }
    DI.register(ProbeEntries).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    await run(listing(() => true), async () => 'io');
    await run(listing(() => false), async () => 'io');
    let io = false;
    const failing = listing(() => {
      throw new Error('list failed');
    });
    await expect(run(failing, async () => ((io = true), 'io'))).to.be.rejectedWith('list failed');
    expect(io).to.equal(false);
    expect(seen).to.deep.equal([true, true, false, false]);
    expect(probes).to.equal(3);
    expect(inside).to.deep.equal([true, true, true]);
    DI.unregister(ProbeEntries);
  });

  it('runs after hooks of a stream action at close and delivers close after they settle', async () => {
    const order: string[] = [];
    class Slow extends FsMiddleware {
      async before() {}
      async after(_ctx: FsActionContext, result: unknown) {
        await new Promise((r) => setTimeout(r, 20));
        order.push('after');
        return result;
      }
    }
    DI.register(Slow).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    const stream = await run(fakeFs('on'), async () => new PassThrough(), { stream: true });
    const closed = new Promise<void>((resolve) => stream.on('close', () => (order.push('close'), resolve())));
    stream.resume();
    stream.end('data');
    await closed;
    expect(order).to.deep.equal(['after', 'close']);
    DI.unregister(Slow);
  });
});
