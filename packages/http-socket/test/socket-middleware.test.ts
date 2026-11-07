import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { Forbidden, InvalidOperation } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy, UseSocketMiddleware } from '../src/decorators.js';
import { IRegisteredHandler, ISocketCallStorage, ISocketCommandContext, ISocketFinishContext, ISocketReplyContext, STAGE_ORDER, SocketMiddleware } from '../src/interfaces.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { ITestServer, command, errorOf, nextId, open, resultOf, startServer, waitFor } from './harness.js';

interface IGate {
  promise: Promise<void>;
  open(): void;
}

function gate(): IGate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const store = () => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();

const mine = (name: string) => name.startsWith('mw.') || name.startsWith('tagged.');

export const mwProbe = {
  log: [] as string[],
  registered: [] as string[],
  handlerRuns: [] as string[],
  outsideAls: [] as string[],
  slow: gate(),
  hold: gate(),
  removed: false,
  finished: [] as string[],
  reset(): void {
    this.log = [];
    this.registered = [];
    this.handlerRuns = [];
    this.outsideAls = [];
    this.slow = gate();
    this.hold = gate();
    this.removed = false;
    this.finished = [];
  },
};
mwProbe.reset();

function outcome(ctx: ISocketReplyContext): string {
  return ctx.error !== undefined ? `error ${(ctx.error as SocketException).code ?? (ctx.error as Error).constructor.name}` : JSON.stringify(ctx.result);
}

/** `expected` appears in `log` in this order, other lines in between allowed. */
function inOrder(log: string[], expected: string[]): void {
  let at = 0;
  for (const line of log) {
    if (line === expected[at]) at++;
  }
  expect(at, `${JSON.stringify(expected)} in order in ${JSON.stringify(log)}`).to.equal(expected.length);
}

function als(ctx: ISocketCommandContext, hook: string): void {
  if (store() !== ctx.storage) {
    mwProbe.outsideAls.push(hook);
  }
}

/** Before the lookup ( Order 110 ), so it also sees a command no handler has. */
@Injectable(SocketMiddleware)
export class MwOuter extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Size + 10;

  public onRegister(handler: IRegisteredHandler): void {
    if (mine(handler.fullName)) mwProbe.registered.push(`outer ${handler.fullName}`);
  }

  public onBefore(ctx: ISocketCommandContext): void {
    if (!mine(ctx.request.name)) return;
    als(ctx, 'outer before');
    mwProbe.log.push(`outer before handler=${ctx.handler !== undefined}`);
  }

  public async onAfter(ctx: ISocketReplyContext): Promise<void> {
    if (!mine(ctx.request.name)) return;
    als(ctx, 'outer after');
    mwProbe.log.push(`outer after ${outcome(ctx)}`);
  }

  public onFinish(ctx: ISocketFinishContext): void {
    if (!mine(ctx.request.name)) return;
    als(ctx, 'outer finish');
    mwProbe.log.push(`outer finish aborted=${ctx.aborted}`);
  }
}

/** After the arguments ( Order 710 ): right before the handler. */
@Injectable(SocketMiddleware)
export class MwInner extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Arguments + 10;

  public onRegister(handler: IRegisteredHandler): void {
    if (mine(handler.fullName)) mwProbe.registered.push(`inner ${handler.fullName}`);
  }

  public async onBefore(ctx: ISocketCommandContext): Promise<unknown> {
    if (!mine(ctx.request.name)) return;
    mwProbe.log.push(`inner before handler=${ctx.handler !== undefined} args=${ctx.args !== undefined}`);
    switch (ctx.request.name) {
      case 'mw.short':
        return 'short-circuit';
      case 'mw.short-null':
        return null;
      case 'mw.refused':
        throw new Forbidden('refused by MwInner');
      default:
        return undefined;
    }
  }

  public onAfter(ctx: ISocketReplyContext): void {
    if (!mine(ctx.request.name)) return;
    als(ctx, 'inner after');
    mwProbe.log.push(`inner after ${outcome(ctx)}`);
    if (ctx.request.name === 'mw.rewrite') {
      ctx.result = { wrapped: ctx.result };
    }
    if (ctx.request.name === 'mw.after-throw') {
      throw new SocketException('conflict', 'onAfter failed');
    }
  }

  public async onFinish(ctx: ISocketFinishContext): Promise<void> {
    if (!mine(ctx.request.name)) return;
    mwProbe.log.push(`inner finish aborted=${ctx.aborted}`);
    if (ctx.request.name === 'mw.finish-throw') {
      throw new Error('onFinish failed');
    }
  }
}

@Injectable(SocketMiddleware)
export class MwAround extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Lookup + 20;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName === 'mw.wrap' || handler.fullName === 'mw.twice';
  }

  public async onAround(ctx: ISocketCommandContext, proceed: () => Promise<unknown>): Promise<unknown> {
    als(ctx, 'around');
    if (ctx.request.name === 'mw.twice') {
      await proceed();
      return proceed();
    }
    mwProbe.log.push('around in');
    const result = await proceed();
    mwProbe.log.push(`around out ${JSON.stringify(result)}`);
    return result;
  }
}

/** Mounted on mw.echo only. */
@Injectable(SocketMiddleware)
export class MwOnlyEcho extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Policies + 10;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName === 'mw.echo';
  }

  public onRegister(handler: IRegisteredHandler): void {
    mwProbe.registered.push(`only-echo ${handler.fullName}`);
  }

  public onBefore(ctx: ISocketCommandContext): void {
    mwProbe.log.push(`only-echo ${ctx.request.name}`);
  }
}

/** Global, and declared again on tagged.own: it must run once there. */
@Injectable(SocketMiddleware)
export class MwStamp extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Arguments + 40;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName.startsWith('tagged.');
  }

  public onAfter(ctx: ISocketReplyContext): void {
    if (ctx.error === undefined) ctx.result = `${String(ctx.result)}+stamp`;
  }
}

@NewInstance()
export class MwTag extends SocketMiddleware {
  constructor(
    protected Tag: string,
    public readonly Order: number = STAGE_ORDER.Arguments + 50,
  ) {
    super();
  }

  public onRegister(handler: IRegisteredHandler): void {
    mwProbe.registered.push(`tag ${this.Tag} ${handler.fullName}`);
  }

  public onAfter(ctx: ISocketReplyContext): void {
    if (ctx.error === undefined) ctx.result = `${String(ctx.result)}+${this.Tag}`;
  }
}

/** Only onFinish: what it sees must not depend on another middleware having onAfter. */
@Injectable(SocketMiddleware)
export class MwFinishOnly extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Size - 50;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName.startsWith('fin.');
  }

  public onFinish(ctx: ISocketFinishContext): void {
    if (!ctx.request.name.startsWith('fin.')) return;
    const error = ctx.error === undefined ? 'none' : ((ctx.error as SocketException).code ?? (ctx.error as Error).constructor.name);
    mwProbe.finished.push(`${ctx.request.name} result=${JSON.stringify(ctx.result)} error=${error} aborted=${ctx.aborted}`);
  }
}

/** Holds fin.held before its handler until the test opens the gate. */
@Injectable(SocketMiddleware)
export class MwHold extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Policies + 5;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName === 'fin.held';
  }

  public async onBefore(): Promise<void> {
    await mwProbe.hold.promise;
  }
}

/** Inside the idempotency stage: what it writes is what the key stores. */
@Injectable(SocketMiddleware)
export class MwInsideIdempotency extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Idempotency + 10;

  public isEnabled(handler: IRegisteredHandler): boolean {
    return handler.fullName === 'mw.slow-idem';
  }

  public onAfter(ctx: ISocketReplyContext): void {
    if (ctx.error === undefined) ctx.result = `${String(ctx.result)}+inside`;
  }
}

export class MwDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('never');
  }
}

/** Refuses once the resource is gone, as `@SocketAccess` refuses a row it can no longer load. */
export class MwResourceExists extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    if (mwProbe.removed) {
      throw new Forbidden('the resource is gone');
    }
  }
}

@SocketController('mw')
export class MwSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() p: unknown) {
    mwProbe.handlerRuns.push('echo');
    return p;
  }

  @Command('short')
  public async short() {
    mwProbe.handlerRuns.push('short');
    return 'handler';
  }

  @Command('short-null')
  public async shortNull() {
    mwProbe.handlerRuns.push('short-null');
    return 'handler';
  }

  @Command('refused')
  public async refused() {
    mwProbe.handlerRuns.push('refused');
    return 'handler';
  }

  @Command('rewrite')
  public async rewrite() {
    return 'raw';
  }

  @Command('after-throw')
  public async afterThrow() {
    return 'lost';
  }

  @Command('fail')
  public async fail() {
    throw new SocketException('failed_precondition', 'handler failed');
  }

  @Command('finish-throw')
  public async finishThrow() {
    return 'fine';
  }

  @Command('slow')
  public async slow() {
    mwProbe.handlerRuns.push('slow');
    await mwProbe.slow.promise;
    return 'late';
  }

  @Command('slow-idem', { idempotent: true })
  public async slowIdem() {
    mwProbe.handlerRuns.push('slow-idem');
    await mwProbe.slow.promise;
    return 'late';
  }

  @Command('a', { idempotent: true })
  public async a(@Payload() p: unknown) {
    mwProbe.handlerRuns.push('a');
    return { a: p };
  }

  @Command('b', { idempotent: true })
  @SocketPolicy(MwDeny)
  public async b() {
    mwProbe.handlerRuns.push('b');
    return 'B';
  }

  @Command('wrap')
  public async wrap() {
    mwProbe.log.push('handler');
    return 'wrapped';
  }

  @Command('twice')
  public async twice() {
    return 'twice';
  }

  @Command('remove', { idempotent: true })
  @SocketPolicy(MwResourceExists)
  public async remove() {
    mwProbe.handlerRuns.push('remove');
    mwProbe.removed = true;
    return 'removed';
  }
}

@SocketController('fin')
export class MwFinishSocket extends BaseSocketController {
  @Command('ok')
  public async ok() {
    return { v: 1 };
  }

  @Command('boom')
  public async boom() {
    throw new SocketException('failed_precondition', 'boom');
  }

  @Command('held')
  public async held() {
    mwProbe.handlerRuns.push('held');
    return 'never';
  }
}

@SocketController('tagged')
@UseSocketMiddleware(MwTag, 'ctrl')
export class MwTaggedSocket extends BaseSocketController {
  @Command('plain')
  public async plain() {
    return 'v';
  }

  @Command('own')
  @UseSocketMiddleware(MwTag, 'cmd')
  public async own() {
    return 'v';
  }

  @Command('outer')
  @UseSocketMiddleware(MwTag, 'first', STAGE_ORDER.Lookup + 1)
  public async outer() {
    return 'v';
  }

  @Command('stamped')
  @UseSocketMiddleware(MwStamp)
  public async stamped() {
    return 'v';
  }
}

/** A 3.x stage moved onto the new base class without moving its execute(); registered only by the test that needs it. */
export class MwLegacy extends SocketMiddleware {
  public readonly Order = STAGE_ORDER.Lookup + 1;

  public async execute(_ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    return next();
  }
}

describe('SocketMiddleware', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    mwProbe.reset();
    t = await startServer();
    socket = await open(t, { auth: { token: 'good' } });
  });

  afterEach(async () => {
    mwProbe.slow.open();
    socket.close();
    await t.close();
  });

  describe('registration', () => {
    it('calls onRegister in Order for the enabled middlewares of each command only', async () => {
      expect(mwProbe.registered.filter((x) => x.endsWith(' mw.echo'))).to.deep.equal(['outer mw.echo', 'only-echo mw.echo', 'inner mw.echo']);
      expect(mwProbe.registered.filter((x) => x.startsWith('only-echo'))).to.deep.equal(['only-echo mw.echo']);
    });

    it('keeps the enabled middlewares of each command, in Order, on its registration', async () => {
      const registry = await DI.resolve(SocketHandlerRegistry);
      const names = (name: string) => registry.command(name)!.middlewares!.map((m) => m.constructor.name);

      inOrder(names('mw.echo'), ['SizeStage', 'MwOuter', 'RateStage', 'InFlightStage', 'ReadyStage', 'AuthenticationStage', 'LookupStage', 'IdempotencyStage', 'OrderingStage', 'PoliciesStage', 'MwOnlyEcho', 'ArgumentsStage', 'MwInner']);
      expect(names('mw.wrap')).to.include('MwAround');
      expect(names('mw.echo')).to.not.include('MwAround');
      expect(registry.Middlewares.map((m) => m.constructor.name)).to.include.members(['MwOuter', 'MwInner', 'MwAround', 'MwOnlyEcho']);
    });

    it('fails the build for a middleware that still defines execute( ctx, next )', async () => {
      socket.close();
      await t.close();
      DI.register(MwLegacy).as(SocketMiddleware);
      try {
        const err = await startServer().then(
          () => expect.fail('the server started'),
          (e: unknown) => e as InvalidOperation,
        );

        expect(err).to.be.instanceOf(InvalidOperation);
        expect(err.message).to.match(/^Socket middleware MwLegacy defines execute\(ctx, next\), removed in @spinajs\/http-socket 4\.0: implement onAround\(ctx, proceed\)/);
      } finally {
        DI.unregister(MwLegacy);
        t = await startServer();
        socket = await open(t, { auth: { token: 'good' } });
      }
    });
  });

  describe('hooks', () => {
    it('runs onBefore in Order and onAfter inner first, inside the call store, then onFinish once the ack is out', async () => {
      expect(resultOf(await command(socket, 'mw.echo', { a: 1 }))).to.deep.equal({ a: 1 });
      await waitFor(() => mwProbe.log.includes('outer finish aborted=false'));

      expect(mwProbe.log).to.deep.equal([
        'outer before handler=false',
        'only-echo mw.echo',
        'inner before handler=true args=true',
        'inner after {"a":1}',
        'outer after {"a":1}',
        'inner finish aborted=false',
        'outer finish aborted=false',
      ]);
      expect(mwProbe.outsideAls).to.deep.equal([]);
    });

    it('answers with what onBefore returned: no later middleware and no handler run, every entered onAfter sees it', async () => {
      expect(resultOf(await command(socket, 'mw.short'))).to.equal('short-circuit');
      expect(mwProbe.handlerRuns).to.deep.equal([]);
      inOrder(mwProbe.log, ['inner after "short-circuit"', 'outer after "short-circuit"']);
    });

    it('answers null when onBefore returns null; undefined goes on', async () => {
      expect(resultOf(await command(socket, 'mw.short-null'))).to.equal(null);
      expect(mwProbe.handlerRuns).to.deep.equal([]);
      expect(resultOf(await command(socket, 'mw.echo', 'x'))).to.equal('x');
    });

    it('gives neither onAfter nor onFinish to a middleware whose onBefore threw; the outer ones see the error', async () => {
      expect(errorOf(await command(socket, 'mw.refused')).code).to.equal('forbidden');
      await waitFor(() => mwProbe.log.includes('outer finish aborted=false'));

      expect(mwProbe.handlerRuns).to.deep.equal([]);
      expect(mwProbe.log.filter((x) => x.startsWith('inner'))).to.deep.equal(['inner before handler=true args=true']);
      expect(mwProbe.log).to.include('outer after error Forbidden');
    });

    it('lets onAfter change the result for the outer middlewares and the client', async () => {
      expect(resultOf(await command(socket, 'mw.rewrite'))).to.deep.equal({ wrapped: 'raw' });
      inOrder(mwProbe.log, ['inner after "raw"', 'outer after {"wrapped":"raw"}']);
    });

    it('runs onAfter on an error with ctx.error set', async () => {
      expect(errorOf(await command(socket, 'mw.fail')).code).to.equal('failed_precondition');
      inOrder(mwProbe.log, ['inner after error failed_precondition', 'outer after error failed_precondition']);
    });

    it('turns the reply into the error a throwing onAfter threw; the outer onAfter sees it', async () => {
      const error = errorOf(await command(socket, 'mw.after-throw'));

      expect(error.code).to.equal('conflict');
      expect(error.message).to.equal('onAfter failed');
      expect(mwProbe.log).to.include('outer after error conflict');
    });

    it('logs a throwing onFinish and still runs the other ones', async () => {
      expect(resultOf(await command(socket, 'mw.finish-throw'))).to.equal('fine');
      await waitFor(() => mwProbe.log.includes('outer finish aborted=false'));
      expect(mwProbe.log).to.include('inner finish aborted=false');
    });

    it('runs onFinish with aborted after the abort answered and the chain settled', async () => {
      const id = nextId();
      const reply = command(socket, 'mw.slow', undefined, { id });
      await waitFor(() => mwProbe.handlerRuns.includes('slow'));
      socket.emit(WIRE_EVENTS.cancel, { id });

      expect(errorOf(await reply).code).to.equal('cancelled');
      expect(mwProbe.log.some((x) => x.includes('finish'))).to.be.false;

      mwProbe.slow.open();
      await waitFor(() => mwProbe.log.includes('outer finish aborted=true'));
      expect(mwProbe.log.slice(-4)).to.deep.equal(['inner after "late"', 'outer after "late"', 'inner finish aborted=true', 'outer finish aborted=true']);
    });

    it('runs every global middleware up to the lookup for a command no handler has', async () => {
      expect(errorOf(await command(socket, 'mw.nope')).code).to.equal('unimplemented');
      inOrder(mwProbe.log, ['outer before handler=false', 'outer after error unimplemented']);
      expect(mwProbe.log.some((x) => x.startsWith('inner'))).to.be.false;
    });
  });

  describe('onAround', () => {
    it('wraps the later middlewares and the handler; proceed() settles with the result', async () => {
      expect(resultOf(await command(socket, 'mw.wrap'))).to.equal('wrapped');
      inOrder(mwProbe.log, ['outer before handler=false', 'around in', 'inner before handler=true args=true', 'handler', 'inner after "wrapped"', 'around out "wrapped"', 'outer after "wrapped"']);
      expect(mwProbe.outsideAls).to.deep.equal([]);
    });

    it('rejects a second proceed() with internal', async () => {
      const error = errorOf(await command(socket, 'mw.twice'));

      expect(error.code).to.equal('internal');
      expect(error.message).to.equal('proceed() called twice by MwAround');
    });
  });

  describe('@UseSocketMiddleware', () => {
    it('mounts a middleware on every command of the controller, with its options', async () => {
      expect(resultOf(await command(socket, 'tagged.plain'))).to.equal('v+ctrl+stamp');
    });

    it('runs the command one inside the controller one at the same Order', async () => {
      expect(resultOf(await command(socket, 'tagged.own'))).to.equal('v+cmd+ctrl+stamp');
    });

    it('places a per-command middleware by its Order among the global ones', async () => {
      const registry = await DI.resolve(SocketHandlerRegistry);
      const names = registry.command('tagged.outer')!.middlewares!.map((m) => m.constructor.name);

      expect(names.indexOf('MwTag')).to.equal(names.indexOf('LookupStage') + 1);
      expect(resultOf(await command(socket, 'tagged.outer'))).to.equal('v+ctrl+stamp+first');
    });

    it('runs a global middleware once on a command that declares it too', async () => {
      expect(resultOf(await command(socket, 'tagged.stamped'))).to.equal('v+ctrl+stamp');
    });

    it('calls onRegister of each declared instance for its commands', async () => {
      expect(mwProbe.registered).to.include.members(['tag ctrl tagged.plain', 'tag ctrl tagged.own', 'tag cmd tagged.own', 'tag first tagged.outer']);
      expect(mwProbe.registered).to.not.include('tag cmd tagged.plain');
    });
  });

  describe('onFinish outcome', () => {
    it('sees the result with no onAfter in the chain', async () => {
      expect(resultOf(await command(socket, 'fin.ok'))).to.deep.equal({ v: 1 });
      await waitFor(() => mwProbe.finished.length === 1);
      expect(mwProbe.finished).to.deep.equal(['fin.ok result={"v":1} error=none aborted=false']);
    });

    it('sees the handler error', async () => {
      expect(errorOf(await command(socket, 'fin.boom')).code).to.equal('failed_precondition');
      await waitFor(() => mwProbe.finished.length === 1);
      expect(mwProbe.finished).to.deep.equal(['fin.boom result=undefined error=failed_precondition aborted=false']);
    });

    it('sees the refusal of a name no command has', async () => {
      expect(errorOf(await command(socket, 'fin.nope')).code).to.equal('unimplemented');
      await waitFor(() => mwProbe.finished.length === 1);
      expect(mwProbe.finished).to.deep.equal(['fin.nope result=undefined error=unimplemented aborted=false']);
    });

    it('sees SocketClientGone when the command was cancelled before its handler', async () => {
      const id = nextId();
      const reply = command(socket, 'fin.held', undefined, { id });
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.emit(WIRE_EVENTS.cancel, { id });

      expect(errorOf(await reply).code).to.equal('cancelled');
      mwProbe.hold.open();
      await waitFor(() => mwProbe.finished.length === 1);
      expect(mwProbe.finished).to.deep.equal(['fin.held result=undefined error=cancelled aborted=true']);
      expect(mwProbe.handlerRuns).to.deep.equal([]);
    });
  });

  describe('onAfter after an abort', () => {
    it('still shapes what the idempotency stage stores once the client cancelled', async () => {
      const id = nextId();
      const reply = command(socket, 'mw.slow-idem', undefined, { id, idempotencyKey: 'cancelled-key' });
      await waitFor(() => mwProbe.handlerRuns.includes('slow-idem'));
      socket.emit(WIRE_EVENTS.cancel, { id });
      expect(errorOf(await reply).code).to.equal('cancelled');

      mwProbe.slow.open();
      await waitFor(() => mwProbe.log.includes('outer finish aborted=true'));

      expect(resultOf(await command(socket, 'mw.slow-idem', undefined, { idempotencyKey: 'cancelled-key' }))).to.equal('late+inside');
      expect(mwProbe.handlerRuns).to.deep.equal(['slow-idem']);
    });
  });

  describe('idempotency key reuse', () => {
    it('refuses a key reused by another command instead of replaying the first one', async () => {
      expect(resultOf(await command(socket, 'mw.a', 1, { idempotencyKey: 'shared' }))).to.deep.equal({ a: 1 });

      const error = errorOf(await command(socket, 'mw.b', undefined, { idempotencyKey: 'shared' }));

      expect(error.code).to.equal('failed_precondition');
      expect(error.details).to.deep.equal({ reason: 'idempotency_key_reuse' });
      expect(mwProbe.handlerRuns).to.deep.equal(['a']);
    });

    it('refuses a key reused with another payload, and replays the same request', async () => {
      expect(resultOf(await command(socket, 'mw.a', 1, { idempotencyKey: 'once' }))).to.deep.equal({ a: 1 });

      expect(errorOf(await command(socket, 'mw.a', 2, { idempotencyKey: 'once' })).code).to.equal('failed_precondition');
      expect(resultOf(await command(socket, 'mw.a', 1, { idempotencyKey: 'once' }))).to.deep.equal({ a: 1 });
      expect(mwProbe.handlerRuns).to.deep.equal(['a']);
    });
  });

  describe('idempotency before policies', () => {
    it('places idempotency and ordering before the policies', () => {
      expect(STAGE_ORDER.Idempotency).to.be.lessThan(STAGE_ORDER.Ordering);
      expect(STAGE_ORDER.Ordering).to.be.lessThan(STAGE_ORDER.Policies);
    });

    it('replays a completed key although its policy would refuse the command now', async () => {
      expect(resultOf(await command(socket, 'mw.remove', undefined, { idempotencyKey: 'k1' }))).to.equal('removed');
      expect(resultOf(await command(socket, 'mw.remove', undefined, { idempotencyKey: 'k1' }))).to.equal('removed');
      expect(errorOf(await command(socket, 'mw.remove', undefined, { idempotencyKey: 'k2' })).code).to.equal('forbidden');
      expect(mwProbe.handlerRuns).to.deep.equal(['remove']);
    });
  });
});
