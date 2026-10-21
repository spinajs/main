import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import type { IContainer } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';

import { ActionHook, ActionHookFailed, ActionRefused } from '../src/index.js';
import type { ActionPattern, AfterContext, BeforeContext, FailedContext, Hooks } from '../src/index.js';
import { TestLog, addHook, boot, disposeChildren, rejectionOf, track, useTestLog } from './support.js';

const expect = chai.expect;

interface Account {
  login: string;
  email: string;
  role: string;
  password: string;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'run.account': { input: Account; output: { id: string } };
    'run.outer': { input: { tag: string }; output: string };
    'run.inner': { input: { tag: string }; output: string };
    'run.nest': { input: { level: number }; output: number };
    'run.optional': { input: { name: string; note?: string }; output: string };
  }
}

const PASSWORD = 'correct horse battery staple';
const account = (): Account => ({ login: 'alice.smith', email: 'alice@example.com', role: 'user', password: PASSWORD });
const created = async () => ({ id: 'u-1' });

/** Appends `<name>:<phase>` to `seen` for every phase it runs. */
class Step extends ActionHook {
  constructor(private readonly name: string, readonly order: number, private readonly seen: string[], readonly actions: readonly ActionPattern[] = ['run.account']) {
    super();
  }

  before(): void {
    this.seen.push(`${this.name}:before`);
  }

  after(): void {
    this.seen.push(`${this.name}:after`);
  }

  failed(): void {
    this.seen.push(`${this.name}:failed`);
  }
}

class Refuser extends ActionHook<'run.account'> {
  readonly actions: readonly ActionPattern[] = ['run.account'];

  constructor(private readonly code = 'quota_exceeded') {
    super();
  }

  before(ctx: BeforeContext<'run.account'>): void {
    ctx.refuse(this.code, 'refused by the test');
  }
}

class Exploding extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['run.account'];

  before(): void {
    throw new TypeError('boom');
  }
}

class RejectingLater extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['run.account'];

  async before(): Promise<void> {
    await Promise.resolve();
    throw new RangeError('later boom');
  }
}

class Stalling extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['run.account'];

  before(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
}

describe('DefaultHooks.run', function () {
  this.timeout(10000);
  useTestLog();

  let clock: sinon.SinonFakeTimers | undefined;

  afterEach(async () => {
    clock?.restore();
    clock = undefined;
    await disposeChildren();
  });

  const fakeTimers = () => (clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

  describe('order', () => {
    it('runs before hooks in ascending order, after and failed hooks in descending order, ties in registration order', async () => {
      const seen: string[] = [];
      const { hooks } = await boot({}, (c) => {
        for (const h of [new Step('a', 0, seen), new Step('b', -5, seen), new Step('c', 10, seen), new Step('d', 0, seen)]) addHook(c, h);
      });

      await hooks.run('run.account', account(), created, { mutable: [] });
      expect(seen).to.deep.eq(['b:before', 'a:before', 'd:before', 'c:before', 'c:after', 'a:after', 'd:after', 'b:after']);

      seen.length = 0;
      await rejectionOf(
        hooks.run(
          'run.account',
          account(),
          async () => {
            throw new Error('impl failed');
          },
          { mutable: [] },
        ),
      );
      expect(seen).to.deep.eq(['b:before', 'a:before', 'd:before', 'c:before', 'c:failed', 'a:failed', 'd:failed', 'b:failed']);
    });
  });

  describe('mutable keys', () => {
    class Renaming extends ActionHook<'run.account'> {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      before(ctx: BeforeContext<'run.account'>): void {
        ctx.input.login = 'renamed.login';
        ctx.input.role = 'role-from-renaming';
        ctx.input.password = 'password-from-renaming';
      }
    }

    class Readdressing extends ActionHook<'run.account'> {
      readonly actions: readonly ActionPattern[] = ['run.account'];
      readonly order = 1;

      before(ctx: BeforeContext<'run.account'>): void {
        ctx.input.email = 'new@example.com';
        ctx.input.role = 'role-from-readdressing';
      }
    }

    it('passes impl the mutable keys hooks changed and the original value of every other key', async () => {
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Renaming());
        addHook(c, new Readdressing());
      });
      const input = account();
      const received: Account[] = [];

      await hooks.run(
        'run.account',
        input,
        async (i) => {
          received.push(i);
          return { id: 'u-1' };
        },
        { mutable: ['login', 'email'] },
      );

      expect(received).to.have.length(1);
      expect(received[0]).to.deep.eq({ login: 'renamed.login', email: 'new@example.com', role: 'user', password: PASSWORD });
      expect(input).to.deep.eq(account());
    });

    it('warns once per hook class that assigned a key the action does not declare mutable', async () => {
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Renaming());
        addHook(c, new Readdressing());
      });

      await hooks.run('run.account', account(), created, { mutable: ['login', 'email'] });
      await hooks.run('run.account', account(), created, { mutable: ['login', 'email'] });

      const warns = TestLog.of('hooks', 'warn');
      expect(warns.filter((w) => w.text.includes('Renaming'))).to.have.length(1);
      expect(warns.filter((w) => w.text.includes('Readdressing'))).to.have.length(1);
      for (const w of warns) {
        expect(w.text).to.not.contain('role-from-');
        expect(w.text).to.not.contain('password-from-renaming');
        expect(w.text).to.not.contain(PASSWORD);
      }
    });
  });

  describe('refusal', () => {
    it('throws ActionRefused with the action and the code, and runs neither impl nor any later hook', async () => {
      const seen: string[] = [];
      const impl = sinon.spy(created);
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Refuser());
        addHook(c, new Step('later', 1, seen));
      });

      const e = await rejectionOf(hooks.run('run.account', account(), impl, { mutable: [] }));

      expect(e).to.be.instanceOf(ActionRefused);
      expect((e as ActionRefused).action).to.eq('run.account');
      expect((e as ActionRefused).code).to.eq('quota_exceeded');
      expect(impl.called).to.be.false;
      expect(seen).to.deep.eq([]);
    });

    it('accepts a code of 1 to 59 characters from [a-z0-9_.-] that starts with a letter or a digit', async () => {
      for (const code of ['a', '0', 'a'.repeat(59), 'hook_x.y-z', '9lives']) {
        const { hooks } = await boot({}, (c) => addHook(c, new Refuser(code)));
        const e = await rejectionOf(hooks.run('run.account', account(), created, { mutable: [] }));
        expect(e, code).to.be.instanceOf(ActionRefused);
        expect((e as ActionRefused).code, code).to.eq(code);
      }
    });

    it('turns a refusal with any other code into ActionHookFailed(error)', async () => {
      for (const code of ['', 'Upper', '-lead', '_lead', '.lead', 'has space', 'hook:x', 'ünicode', 'a'.repeat(60)]) {
        const impl = sinon.spy(created);
        const { hooks } = await boot({}, (c) => addHook(c, new Refuser(code)));
        const e = await rejectionOf(hooks.run('run.account', account(), impl, { mutable: [] }));
        expect(e, code).to.be.instanceOf(ActionHookFailed);
        expect((e as ActionHookFailed).reason, code).to.eq('error');
        expect((e as ActionHookFailed).hook, code).to.eq('Refuser');
        expect(impl.called, code).to.be.false;
      }
    });

    it('turns any other throw into ActionHookFailed(error) naming the hook class, and stops the run', async () => {
      for (const failing of [new Exploding(), new RejectingLater()]) {
        const seen: string[] = [];
        const impl = sinon.spy(created);
        const { hooks } = await boot({}, (c) => {
          addHook(c, failing);
          addHook(c, new Step('later', 1, seen));
        });

        const e = await rejectionOf(hooks.run('run.account', account(), impl, { mutable: [] }));

        expect(e).to.be.instanceOf(ActionHookFailed);
        expect((e as ActionHookFailed).reason).to.eq('error');
        expect((e as ActionHookFailed).hook).to.eq(failing.constructor.name);
        expect((e as ActionHookFailed).action).to.eq('run.account');
        expect(impl.called).to.be.false;
        expect(seen).to.deep.eq([]);
      }
    });

    it('turns a before hook slower than hooks.timeoutMs into ActionHookFailed(timeout)', async () => {
      const impl = sinon.spy(created);
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => addHook(c, new Stalling()));
      const timers = fakeTimers();

      const run = track(hooks.run('run.account', account(), impl, { mutable: [] }));
      await timers.tickAsync(99);
      expect(run.settled).to.be.false;
      await timers.tickAsync(1);

      expect(run.settled).to.be.true;
      expect(run.error).to.be.instanceOf(ActionHookFailed);
      expect((run.error as ActionHookFailed).reason).to.eq('timeout');
      expect((run.error as ActionHookFailed).hook).to.eq('Stalling');
      expect(impl.called).to.be.false;
    });

    it('with refusable: false, logs a refusal and a throw and runs the action', async () => {
      const seen: string[] = [];
      const impl = sinon.spy(created);
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Refuser());
        addHook(c, new Exploding());
        addHook(c, new Step('later', 1, seen));
      });

      const out = await hooks.run('run.account', account(), impl, { mutable: [], refusable: false });

      expect(out).to.deep.eq({ id: 'u-1' });
      expect(impl.calledOnce).to.be.true;
      expect(seen).to.deep.eq(['later:before', 'later:after']);
      const logged = TestLog.of('hooks');
      expect(logged.some((l) => l.text.includes('Refuser'))).to.be.true;
      expect(logged.some((l) => l.text.includes('Exploding'))).to.be.true;
    });
  });

  describe('failure', () => {
    class ErrorWatcher extends ActionHook {
      readonly errors: unknown[] = [];

      constructor(readonly order: number, private readonly seen: string[], readonly actions: readonly ActionPattern[] = ['run.account']) {
        super();
      }

      failed(ctx: FailedContext<'run.account'>): void {
        this.seen.push(`watcher${this.order}`);
        this.errors.push(ctx.error);
      }
    }

    class BrokenFailed extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];
      readonly order = 5;

      constructor(private readonly seen: string[]) {
        super();
      }

      failed(): void {
        this.seen.push('broken');
        throw new SyntaxError('failed hook broke');
      }
    }

    it('shows failed hooks the error, logs a failing failed hook, and rethrows the original error', async () => {
      const seen: string[] = [];
      const first = new ErrorWatcher(0, seen);
      const last = new ErrorWatcher(-5, seen);
      const afterSeen: string[] = [];
      const { hooks } = await boot({}, (c) => {
        addHook(c, first);
        addHook(c, new BrokenFailed(seen));
        addHook(c, last);
        addHook(c, new Step('observer', 0, afterSeen));
      });
      const failure = new RangeError('impl failed');

      const e = await rejectionOf(
        hooks.run(
          'run.account',
          account(),
          async () => {
            throw failure;
          },
          { mutable: [] },
        ),
      );

      expect(e).to.equal(failure);
      expect(seen).to.deep.eq(['broken', 'watcher0', 'watcher-5']);
      expect(first.errors).to.deep.eq([failure]);
      expect(last.errors).to.deep.eq([failure]);
      expect(afterSeen).to.deep.eq(['observer:before', 'observer:failed']);
      expect(TestLog.of('hooks').some((l) => l.text.includes('BrokenFailed'))).to.be.true;
    });
  });

  describe('after', () => {
    class ThrowingAfter extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];
      readonly order = 5;

      after(): void {
        throw new TypeError('after broke');
      }
    }

    class StallingAfter extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];
      readonly order = 3;

      after(): Promise<void> {
        return new Promise<void>(() => undefined);
      }
    }

    it('logs an after hook that throws or times out and returns the output unchanged', async () => {
      const seen: string[] = [];
      const output = { id: 'u-1' };
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => {
        addHook(c, new ThrowingAfter());
        addHook(c, new StallingAfter());
        addHook(c, new Step('tail', 0, seen));
      });
      const timers = fakeTimers();

      const run = track(hooks.run('run.account', account(), async () => output, { mutable: [] }));
      await timers.tickAsync(100);

      expect(run.settled).to.be.true;
      expect(run.error).to.be.undefined;
      expect(run.value).to.equal(output);
      expect(output).to.deep.eq({ id: 'u-1' });
      expect(seen).to.deep.eq(['tail:before', 'tail:after']);
      const logged = TestLog.of('hooks');
      expect(logged.some((l) => l.text.includes('ThrowingAfter'))).to.be.true;
      expect(logged.some((l) => l.text.includes('StallingAfter'))).to.be.true;
    });
  });

  describe('logging', () => {
    const SECRET = 'detail-that-must-stay-private';

    class LeakyBefore extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      before(ctx: BeforeContext<'run.account'>): void {
        throw new SyntaxError(`${SECRET} ${ctx.input.password}`);
      }
    }

    class LeakyAfter extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      after(ctx: AfterContext<'run.account'>): void {
        throw new URIError(`${SECRET} ${ctx.input.password}`);
      }
    }

    it('logs the hook class, the action and the error class, never the error message or an input value', async () => {
      const { hooks } = await boot({}, (c) => {
        addHook(c, new LeakyBefore());
        addHook(c, new LeakyAfter());
      });

      await hooks.run('run.account', account(), created, { mutable: [], refusable: false });

      const logged = TestLog.of('hooks');
      const line = (hook: string) => logged.find((l) => l.text.includes(hook));
      expect(line('LeakyBefore')?.text).to.contain('run.account').and.contain('SyntaxError');
      expect(line('LeakyAfter')?.text).to.contain('run.account').and.contain('URIError');
      for (const l of logged) {
        expect(l.text).to.not.contain(PASSWORD);
        expect(l.text).to.not.contain(SECRET);
        expect(l.text).to.not.contain('alice.smith');
        expect(l.text).to.not.contain('alice@example.com');
      }
    });
  });

  describe('review fixes', () => {
    const optionalImpl = (seen: unknown[]) => async (i: { name: string; note?: string }) => {
      seen.push(i);
      return 'ok';
    };

    class Passing extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.optional'];
      before(): void {}
    }

    class DeletingMutable extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      before(ctx: BeforeContext<'run.account'>): void {
        delete (ctx.input as Partial<Account>).login;
      }
    }

    class HandBuiltRefusal extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      before(): void {
        throw new ActionRefused('run.account', 'forged');
      }
    }

    class NonObjectInput extends ActionHook {
      readonly actions: readonly ActionPattern[] = ['run.account'];

      before(ctx: BeforeContext<'run.account'>): void {
        ctx.input = 5 as never;
      }
    }

    it('keeps an absent mutable key absent', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new Passing()));
      const seen: object[] = [];

      await hooks.run('run.optional', { name: 'n' }, optionalImpl(seen), { mutable: ['note'] });

      expect(seen).to.have.length(1);
      expect(Object.hasOwn(seen[0], 'note')).to.be.false;
    });

    it('gives impl the original value of a mutable key a hook deleted', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new DeletingMutable()));
      const received: Account[] = [];

      await hooks.run('run.account', account(), async (i) => (received.push(i), { id: 'u' }), { mutable: ['login'] });

      expect(received[0].login).to.eq('alice.smith');
    });

    it('logs a before hook error on the refusable path with the error class only', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new Exploding()));

      await rejectionOf(hooks.run('run.account', account(), created, { mutable: [] }));

      const logged = TestLog.of('hooks');
      expect(logged).to.have.length(1);
      expect(logged[0].text).to.contain('Exploding').and.contain('run.account').and.contain('TypeError');
      expect(logged[0].text).to.not.contain('boom');
    });

    it('turns an ActionRefused a hook built by hand into a logged ActionHookFailed(error)', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new HandBuiltRefusal()));

      const e = await rejectionOf(hooks.run('run.account', account(), created, { mutable: [] }));

      expect(e).to.be.instanceOf(ActionHookFailed);
      expect((e as ActionHookFailed).reason).to.eq('error');
      expect(TestLog.of('hooks').some((l) => l.text.includes('HandBuiltRefusal'))).to.be.true;
    });

    it('turns a refusal from a nested run of another action into ActionHookFailed(error)', async () => {
      const holder: { hooks?: Hooks } = {};
      class Nesting extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.outer'];

        async before(): Promise<void> {
          await holder.hooks!.run('run.inner', { tag: 'x' }, async () => 'in', { mutable: [] });
        }
      }
      class InnerRefuser extends ActionHook<'run.inner'> {
        readonly actions: readonly ActionPattern[] = ['run.inner'];

        before(ctx: BeforeContext<'run.inner'>): void {
          ctx.refuse('inner_code');
        }
      }
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Nesting());
        addHook(c, new InnerRefuser());
      });
      holder.hooks = hooks;

      const e = await rejectionOf(hooks.run('run.outer', { tag: 'o' }, async () => 'out', { mutable: [] }));

      expect(e).to.be.instanceOf(ActionHookFailed);
      expect((e as ActionHookFailed).hook).to.eq('Nesting');
    });

    it('treats a non-object ctx.input as a before hook error', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new NonObjectInput()));

      const e = await rejectionOf(hooks.run('run.account', account(), created, { mutable: ['login'] }));
      expect(e).to.be.instanceOf(ActionHookFailed);
      expect((e as ActionHookFailed).reason).to.eq('error');
      expect((e as ActionHookFailed).hook).to.eq('NonObjectInput');

      const received: Account[] = [];
      await hooks.run('run.account', account(), async (i) => (received.push(i), { id: 'u' }), { mutable: ['login'], refusable: false });
      expect(received[0]).to.deep.eq(account());
    });
  });

  describe('bag', () => {
    it('carries what a before hook set to the after and failed hooks of the same run, and starts empty on each run', async () => {
      const reads: unknown[][] = [];
      class Writer extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.account'];
        readonly order = -1;

        before(ctx: BeforeContext<'run.account'>): void {
          reads.push(['before', ctx.bag.size]);
          ctx.bag.set('started', ctx.input.login);
        }
      }
      class Reader extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.account'];

        after(ctx: AfterContext<'run.account'>): void {
          reads.push(['after', ctx.bag.get('started')]);
        }

        failed(ctx: FailedContext<'run.account'>): void {
          reads.push(['failed', ctx.bag.get('started')]);
        }
      }
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Writer());
        addHook(c, new Reader());
      });

      await hooks.run('run.account', account(), created, { mutable: [] });
      await rejectionOf(
        hooks.run(
          'run.account',
          { ...account(), login: 'bob' },
          async () => {
            throw new Error('impl failed');
          },
          { mutable: [] },
        ),
      );

      expect(reads).to.deep.eq([
        ['before', 0],
        ['after', 'alice.smith'],
        ['before', 0],
        ['failed', 'bob'],
      ]);
    });
  });

  describe('depth', () => {
    it('shows depth 1 to a top-level run and 2 to an action a hook runs', async () => {
      const ref: { hooks?: Hooks } = {};
      const depths: string[] = [];
      class Outer extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.outer'];

        async before(ctx: BeforeContext<'run.outer'>): Promise<void> {
          depths.push(`outer:${ctx.depth}`);
          await ref.hooks!.run('run.inner', { tag: 'nested' }, async (i) => i.tag, { mutable: [] });
        }
      }
      class Inner extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.inner'];

        before(ctx: BeforeContext<'run.inner'>): void {
          depths.push(`inner:${ctx.depth}`);
        }
      }
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Outer());
        addHook(c, new Inner());
      });
      ref.hooks = hooks;

      await hooks.run('run.outer', { tag: 'top' }, async (i) => i.tag, { mutable: [] });
      await hooks.run('run.inner', { tag: 'top' }, async (i) => i.tag, { mutable: [] });

      expect(depths).to.deep.eq(['outer:1', 'inner:2', 'inner:1']);
    });

    it('throws ActionHookFailed(depth) for a run past hooks.maxDepth', async () => {
      const ref: { hooks?: Hooks } = {};
      const depths: number[] = [];
      const errors: unknown[] = [];
      const levels: number[] = [];
      const impl = async (i: { level: number }) => {
        levels.push(i.level);
        return i.level;
      };
      class Recursing extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['run.nest'];

        async before(ctx: BeforeContext<'run.nest'>): Promise<void> {
          depths.push(ctx.depth);
          try {
            await ref.hooks!.run('run.nest', { level: ctx.input.level + 1 }, impl, { mutable: [] });
          } catch (e) {
            errors.push(e);
          }
        }
      }
      const { hooks } = await boot({ hooks: { maxDepth: 3 } }, (c) => addHook(c, new Recursing()));
      ref.hooks = hooks;

      expect(await hooks.run('run.nest', { level: 0 }, impl, { mutable: [] })).to.eq(0);

      expect(depths).to.deep.eq([1, 2, 3]);
      expect(errors).to.have.length(1);
      expect(errors[0]).to.be.instanceOf(ActionHookFailed);
      expect((errors[0] as ActionHookFailed).reason).to.eq('depth');
      expect((errors[0] as ActionHookFailed).action).to.eq('run.nest');
      expect(levels).to.deep.eq([2, 1, 0]);
    });
  });

  describe('zero cost', () => {
    const spyContext = (hooks: Hooks) => sinon.spy(hooks as unknown as { createContext: (...args: unknown[]) => unknown }, 'createContext');

    const cases: [string, (c: IContainer) => void][] = [
      ['no hook is registered', () => undefined],
      ['no registered hook matches', (c) => addHook(c, new Step('elsewhere', 0, [], ['run.inner']))],
    ];
    for (const [title, register] of cases) {
      it(`calls impl with the input object itself and builds no context when ${title}`, async () => {
        const { hooks } = await boot({}, register);
        const createContext = spyContext(hooks);
        const input = account();
        const output = { id: 'u-1' };
        const received: Account[] = [];

        const out = await hooks.run(
          'run.account',
          input,
          async (i) => {
            received.push(i);
            return output;
          },
          { mutable: ['login'] },
        );

        expect(out).to.equal(output);
        expect(received).to.have.length(1);
        expect(received[0]).to.equal(input);
        expect(createContext.called).to.be.false;
      });
    }

    it('builds one context per run that has a matching hook', async () => {
      const { hooks } = await boot({}, (c) => {
        addHook(c, new Step('a', 0, []));
        addHook(c, new Step('b', 1, []));
      });
      const createContext = spyContext(hooks);

      await hooks.run('run.account', account(), created, { mutable: [] });

      expect(createContext.calledOnce).to.be.true;
    });
  });
});

describe('ActionRefused and ActionHookFailed', () => {
  it('ActionRefused carries the action and the code', () => {
    const e = new ActionRefused('run.account', 'quota_exceeded', 'over quota');
    expect(e).to.be.instanceOf(Exception).and.instanceOf(Error);
    expect(e.name).to.eq('ActionRefused');
    expect(e.action).to.eq('run.account');
    expect(e.code).to.eq('quota_exceeded');
    expect(e.message).to.eq('over quota');
    expect(new ActionRefused('run.account', 'quota_exceeded').message).to.contain('quota_exceeded');
  });

  it('ActionHookFailed carries the action, the hook class name and the reason', () => {
    for (const reason of ['error', 'timeout', 'depth'] as const) {
      const e = new ActionHookFailed('run.account', 'Exploding', reason);
      expect(e).to.be.instanceOf(Exception).and.instanceOf(Error);
      expect(e.name).to.eq('ActionHookFailed');
      expect(e.action).to.eq('run.account');
      expect(e.hook).to.eq('Exploding');
      expect(e.reason).to.eq(reason);
    }
  });
});
