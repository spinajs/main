import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnConnect, OnDisconnect, OnEvent, SocketController, SocketParameter } from '../src/decorators.js';
import { SocketClientGone, SocketCommandContext } from '../src/context.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { SocketErrorMapper } from '../src/errors.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { CommandOutcome, IConnectionRuntime, IRegisteredHandler, ISocketCallContext, ISocketCallStorage, ISocketCommandContext, ISocketOutcomeRecorder, ISocketStageRegistration, STAGE_ORDER, SocketArg, SocketCommandStage } from '../src/interfaces.js';
import { ITestServer, TestHttpHost, command, configure, delay, errorOf, nextId, open, resultOf, startServer, waitFor } from './harness.js';

interface IGate {
  promise: Promise<void>;
  open(): void;
}

function gate(): IGate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** What the hook stages saw; every stage ignores commands outside `hook.` and `hook-gen.`, so other suites are unaffected. */
export const hookProbe = {
  registered: [] as string[],
  refuseRegistration: null as string | null,
  /** command name to the word each stage passes to refuseStream */
  outerRefusals: new Map<string, string>(),
  innerRefusals: new Map<string, string>(),
  innerSeen: [] as string[],
  handlerRuns: [] as string[],
  started: [] as boolean[],
  downstream: {} as Record<string, unknown>,
  upstream: undefined as unknown,
  earlyGate: gate(),
  earlyError: undefined as unknown,
  lateResult: undefined as unknown,
  handlerGate: gate(),
  reset(): void {
    this.registered = [];
    this.refuseRegistration = null;
    this.outerRefusals = new Map([
      ['hook.plain', 'metered'],
      ['hook-gen.feed', 'metered'],
    ]);
    this.innerRefusals = new Map([
      ['hook.plain', 'audited'],
      ['hook-gen.feed', 'audited'],
    ]);
    this.innerSeen = [];
    this.handlerRuns = [];
    this.started = [];
    this.downstream = {};
    this.upstream = undefined;
    this.earlyGate = gate();
    this.earlyError = undefined;
    this.lateResult = undefined;
    this.handlerGate = gate();
  },
};
hookProbe.reset();

const ours = (name: string) => name.startsWith('hook.') || name.startsWith('hook-gen.');

@Injectable(SocketCommandStage)
export class HookOuterStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Size + 50;
  }

  public onRegister(handler: IRegisteredHandler, registration: ISocketStageRegistration): void {
    if (!ours(handler.fullName)) {
      return;
    }

    hookProbe.registered.push(`outer ${handler.fullName}`);
    const refusal = hookProbe.outerRefusals.get(handler.fullName);
    if (refusal) {
      registration.refuseStream(refusal);
    }
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    switch (ctx.request.name) {
      case 'hook.state': {
        ctx.storage.hookX = 'x';
        const result = await next();
        hookProbe.upstream = ctx.storage.hookZ;
        return result;
      }
      case 'hook.early':
      case 'hook.grace-waiting':
        if (ctx.request.name === 'hook.grace-waiting') {
          ctx.drainGrace = true;
        }
        await hookProbe.earlyGate.promise;
        try {
          return await next();
        } catch (err) {
          hookProbe.earlyError = err;
          throw err;
        }
      case 'hook.grace-run':
        ctx.drainGrace = true;
        return next();
      case 'hook.twice':
        await next();
        return next();
      default:
        return next();
    }
  }
}

@Injectable(SocketCommandStage)
export class HookInnerStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Lookup + 5;
  }

  public onRegister(handler: IRegisteredHandler, registration: ISocketStageRegistration): void {
    if (!ours(handler.fullName)) {
      return;
    }

    hookProbe.registered.push(`inner ${handler.fullName}`);
    if (hookProbe.refuseRegistration === handler.fullName) {
      throw new Error('no audit sink configured');
    }
    const refusal = hookProbe.innerRefusals.get(handler.fullName);
    if (refusal) {
      registration.refuseStream(refusal);
    }
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const name = ctx.request.name;
    if (!ours(name)) {
      return next();
    }

    hookProbe.innerSeen.push(name);
    switch (name) {
      case 'hook.state':
        hookProbe.downstream.stage = ctx.storage.hookX;
        return next();
      case 'hook.started': {
        hookProbe.started.push(ctx.handlerStarted);
        const result = await next();
        hookProbe.started.push(ctx.handlerStarted);
        return result;
      }
      case 'hook.late': {
        const result = await next();
        hookProbe.lateResult = result;
        return result;
      }
      default:
        return next();
    }
  }
}

@Injectable()
export class HookXArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.storage.hookX;
  }
}

const store = () => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore()!;

@SocketController('hook')
export class HookSocket extends BaseSocketController {
  @Command('echo')
  public async echo() {
    hookProbe.handlerRuns.push('echo');
    return 'echo';
  }

  @Command('state')
  public async state(@SocketParameter(HookXArg) x: unknown) {
    hookProbe.downstream.arg = x;
    hookProbe.downstream.handler = store().hookX;
    store().hookZ = 'z';
    return 'state';
  }

  @Command('started')
  public async started() {
    return 'started';
  }

  @Command('plain')
  public async plain() {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  @Command('early')
  public async early() {
    hookProbe.handlerRuns.push('early');
    return 'early';
  }

  @Command('late')
  public async late() {
    hookProbe.handlerRuns.push('late');
    await hookProbe.handlerGate.promise;
    return 'real';
  }

  @Command('grace-run')
  public async graceRun() {
    hookProbe.handlerRuns.push('grace-run');
    await hookProbe.handlerGate.promise;
    return 'graced';
  }

  @Command('nograce-run')
  public async noGraceRun() {
    hookProbe.handlerRuns.push('nograce-run');
    await hookProbe.handlerGate.promise;
    return 'not graced';
  }

  @Command('grace-waiting')
  public async graceWaiting() {
    hookProbe.handlerRuns.push('grace-waiting');
    return 'never';
  }

  @Command('twice')
  public async twice() {
    hookProbe.handlerRuns.push('twice');
    return 'twice';
  }

  @OnEvent('ping')
  public async ping(): Promise<void> {}

  @OnConnect()
  public async hello(): Promise<void> {}

  @OnDisconnect()
  public async bye(): Promise<void> {}
}

/** Registered only by the test that needs it. */
export class HookGenStream extends BaseSocketController {
  @Command('hook-gen.feed')
  public async *feed() {
    yield 1;
  }
}

describe('socket command stage hooks', function () {
  this.timeout(15000);

  beforeEach(() => hookProbe.reset());

  describe('at registration', () => {
    let t: ITestServer | undefined;

    afterEach(async () => {
      await t?.close();
      t = undefined;
    });

    it('calls onRegister once per command and stage, in Order, never for events or hooks', async () => {
      t = await startServer();

      const names = ['hook.echo', 'hook.state', 'hook.started', 'hook.plain', 'hook.early', 'hook.late', 'hook.grace-run', 'hook.nograce-run', 'hook.grace-waiting', 'hook.twice'];
      expect([...hookProbe.registered].sort()).to.deep.equal(names.flatMap((n) => [`inner ${n}`, `outer ${n}`]).sort());
      for (const name of names) {
        expect(hookProbe.registered.indexOf(`outer ${name}`), name).to.be.lessThan(hookProbe.registered.indexOf(`inner ${name}`));
      }
    });

    it('fails the build with an InvalidOperation naming the stage and the command, before socket.io attaches', async () => {
      hookProbe.refuseRegistration = 'hook.echo';
      let host: TestHttpHost | undefined;

      const err = await startServer({}, (h) => (host = h)).then(
        () => expect.fail('the server started'),
        (e: unknown) => e as InvalidOperation,
      );

      expect(err).to.be.instanceOf(InvalidOperation);
      expect(err.message).to.equal('Socket command hook.echo ( HookSocket::echo ): stage HookInnerStage refused the registration: no audit sink configured');
      expect((err.cause as Error).message).to.equal('no audit sink configured');
      expect(host!.Http.listenerCount('upgrade')).to.equal(0);
    });

    it('refuses an async generator under refuseStream, in the words of the highest Order', async () => {
      DI.register(HookGenStream).as(BaseSocketController);
      try {
        const err = await startServer().then(
          () => expect.fail('the server started'),
          (e: unknown) => e as InvalidOperation,
        );

        expect(err).to.be.instanceOf(InvalidOperation);
        expect(err.message).to.equal('Socket command hook-gen.feed ( HookGenStream::feed ) is audited and replies with a stream; audited commands cannot stream');
      } finally {
        DI.unregister(HookGenStream);
      }
    });
  });

  describe('at run time', () => {
    let t: ITestServer;
    let socket: ClientSocket;

    beforeEach(async () => {
      t = await startServer();
      socket = await open(t);
    });

    afterEach(async () => {
      hookProbe.earlyGate.open();
      hookProbe.handlerGate.open();
      socket.close();
      await t.close();
    });

    it('refuses an async-iterable result under refuseStream, in the words of the highest Order', async () => {
      expect((await DI.resolve(SocketHandlerRegistry)).command('hook.plain')?.streamRefusal).to.equal('audited');

      const error = errorOf(await command(socket, 'hook.plain', undefined, { credits: 1 }));

      expect(error.code).to.equal('failed_precondition');
      expect(error.message).to.equal('audited command hook.plain cannot reply with a stream');
    });

    it('sets handlerStarted when the dispatcher calls the handler', async () => {
      expect(resultOf(await command(socket, 'hook.started'))).to.equal('started');
      expect(hookProbe.started).to.deep.equal([false, true]);
    });

    it('spares a started command with drainGrace on abortAll( r, true ), and aborts the others', async () => {
      const dispatcher = await DI.resolve(SocketDispatcher);
      const graced = command(socket, 'hook.grace-run');
      const notGraced = command(socket, 'hook.nograce-run');
      const waiting = command(socket, 'hook.grace-waiting');
      await waitFor(() => hookProbe.handlerRuns.includes('grace-run') && hookProbe.handlerRuns.includes('nograce-run'));

      dispatcher.abortAll(new SocketException('unavailable', 'server is shutting down'), true);

      expect(errorOf(await notGraced).code).to.equal('unavailable');
      expect(errorOf(await waiting).code).to.equal('unavailable');
      hookProbe.handlerGate.open();
      expect(resultOf(await graced)).to.equal('graced');
    });

    it('rejects next() with SocketClientGone before the handler, and runs neither the later stages nor the handler', async () => {
      const id = nextId();
      const reply = command(socket, 'hook.early', undefined, { id });
      await delay(50);
      socket.emit(WIRE_EVENTS.cancel, { id });

      expect(errorOf(await reply).code).to.equal('cancelled');
      hookProbe.earlyGate.open();
      await waitFor(() => hookProbe.earlyError !== undefined);

      const gone = hookProbe.earlyError as SocketClientGone;
      expect(gone).to.be.instanceOf(SocketClientGone);
      expect(gone).to.be.instanceOf(SocketException);
      expect(gone.beforeHandler).to.be.true;
      expect(gone.code).to.equal('cancelled');
      expect(hookProbe.innerSeen).to.not.include('hook.early');
      expect(hookProbe.handlerRuns).to.not.include('early');
    });

    it('settles next() with the real result when the abort came after the handler started', async () => {
      const id = nextId();
      const reply = command(socket, 'hook.late', undefined, { id });
      await waitFor(() => hookProbe.handlerRuns.includes('late'));
      socket.emit(WIRE_EVENTS.cancel, { id });

      expect(errorOf(await reply).code).to.equal('cancelled');
      hookProbe.handlerGate.open();
      await waitFor(() => hookProbe.lateResult !== undefined);
      expect(hookProbe.lateResult).to.equal('real');
    });

    it('rejects a second next() call of one stage with internal', async () => {
      const error = errorOf(await command(socket, 'hook.twice'));

      expect(error.code).to.equal('internal');
      expect(error.message).to.equal('next() called twice by HookOuterStage');
      expect(hookProbe.handlerRuns).to.deep.equal(['twice']);
    });

    it('shares state downstream: an inner stage, a SocketArg and the handler read what an outer stage wrote before next()', async () => {
      expect(resultOf(await command(socket, 'hook.state'))).to.equal('state');
      expect(hookProbe.downstream).to.deep.equal({ stage: 'x', arg: 'x', handler: 'x' });
    });

    it('shares state upstream: the outer stage reads after next() what the handler wrote', async () => {
      await command(socket, 'hook.state');
      expect(hookProbe.upstream).to.equal('z');
    });
  });

  describe('SocketClientGone', () => {
    it('answers the wire exactly as its abort reason', async () => {
      await configure();
      const errors = DI.resolve(SocketErrorMapper);
      const reason = new SocketException('unavailable', 'server is shutting down', { retryAfterMs: 250, details: { why: 'drain' } });

      const gone = new SocketClientGone({ beforeHandler: true }, reason);

      expect(errors.toWire(gone, 'command x')).to.deep.equal(errors.toWire(reason, 'command x'));
      expect(gone.cause).to.equal(reason);
    });
  });

  describe('outcome recorders', () => {
    const context = () => new SocketCommandContext({} as IConnectionRuntime, { id: 'r1', name: 'hook.rec', payload: null }, {} as ISocketCallStorage);

    function recorder(fail?: 'throw' | 'reject') {
      const settled: CommandOutcome[] = [];
      const detached: Promise<unknown>[] = [];
      const r: ISocketOutcomeRecorder = {
        settle: (outcome) => {
          settled.push(outcome);
          if (fail === 'throw') throw new Error('store down');
          return fail === 'reject' ? Promise.reject(new Error('store down')) : Promise.resolve(null);
        },
        detach: (running) => {
          detached.push(running);
          void running.then(
            (result) => r.settle({ result }),
            (error: unknown) => r.settle({ error }),
          ).catch(() => undefined);
        },
      };
      return { r, settled, detached };
    }

    it('recordOutcome settles each recorder once and swallows a failing one', async () => {
      const ctx = context();
      const ok = recorder();
      const throws = recorder('throw');
      const rejects = recorder('reject');
      [ok, throws, rejects].forEach((x) => ctx.addOutcomeRecorder(x.r));

      await ctx.recordOutcome({ result: 42 });

      for (const x of [ok, throws, rejects]) {
        expect(x.settled).to.deep.equal([{ result: 42 }]);
      }
    });

    it('detachOutcome settles every recorder when the handler does', async () => {
      const ctx = context();
      const one = recorder();
      const two = recorder();
      ctx.addOutcomeRecorder(one.r);
      ctx.addOutcomeRecorder(two.r);
      let finish!: (value: unknown) => void;
      const running = new Promise<unknown>((resolve) => (finish = resolve));

      ctx.detachOutcome(running);
      await delay(10);
      expect(one.settled).to.deep.equal([]);

      finish('late');
      await waitFor(() => one.settled.length === 1 && two.settled.length === 1);
      expect(one.detached).to.deep.equal([running]);
      expect(two.settled).to.deep.equal([{ result: 'late' }]);
    });
  });
});
