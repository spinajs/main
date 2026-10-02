import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Socket } from 'socket.io';
import { AsyncService, Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger, newTraceContext } from '@spinajs/log';
import { CommandReply, CommandRequest, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest } from '@spinajs/http-socket-common';
import { IConnectionRuntime, ISocketCallStorage, ISocketServerConfig, SocketCommandStage } from './interfaces.js';
import { SocketConnection } from './connection.js';
import { SocketCommandContext } from './context.js';
import { SocketErrorMapper } from './errors.js';
import { TokenBucket, assertLimitsConfig, assertOrderingConfig } from './limits.js';
import './stages/index.js';

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

@Injectable()
export class SocketDispatcher extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject()
  protected Als: AsyncLocalStorage<ISocketCallStorage>;

  protected Stages: SocketCommandStage[] = [];

  protected runtimes = new Map<string, IConnectionRuntime>();

  public async resolve(): Promise<void> {
    await super.resolve();
    assertLimitsConfig(this.Options);
    assertOrderingConfig(this.Options);
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    this.Stages = [...stages].sort((a, b) => a.Order - b.Order);
  }

  public attach(connection: SocketConnection, socket: Socket): IConnectionRuntime {
    const runtime: IConnectionRuntime = {
      connection,
      bucket: new TokenBucket(this.Options.rate.perSecond, this.Options.rate.burst),
      inFlight: 0,
      running: new Map(),
      ready: Promise.resolve(),
    };

    this.runtimes.set(connection.id, runtime);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));

    return runtime;
  }

  public detach(connection: SocketConnection, _reason: string): void {
    const runtime = this.runtimes.get(connection.id);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(connection.id);
    this.abortRunning(runtime, new SocketException('unavailable', 'connection closed'));
  }

  /** Aborts every running command on every connection ( shutdown ). */
  public abortAll(reason: SocketException): void {
    for (const runtime of this.runtimes.values()) {
      this.abortRunning(runtime, reason);
    }
  }

  /** Runs one command through the stages and the handler; never rejects. */
  public async execute(ctx: SocketCommandContext): Promise<CommandReply> {
    const runtime = ctx.runtime;
    runtime.running.set(ctx.request.id, ctx);

    let reply: CommandReply;

    try {
      await runtime.ready;

      // D14: stages, hydrators and the handler all see the principal ( AuthzService.current() once F4 lands )
      const chain = this.Als.run(ctx.storage, () => this.next(ctx, 0));
      // An abort answers at once; the chain keeps running ( and holds its in-flight slot ) until the handler settles.
      chain.catch(() => undefined);
      const abort = aborted(ctx.signal);
      abort.catch(() => undefined);

      const result = await Promise.race([chain, abort]);
      reply = await this.toReply(ctx, result);
    } catch (err) {
      reply = { id: ctx.request.id, ok: false, error: this.Errors.toWire(err, `command ${ctx.request.name}`) };
    } finally {
      ctx.dispose();
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
    }

    return reply;
  }

  protected onCommand(runtime: IConnectionRuntime, raw: unknown, ack: unknown): void {
    if (typeof ack !== 'function') {
      this.Log.warn(`Socket command without an ack callback from connection ${runtime.connection.id}, ignored`);
      return;
    }

    const reply = ack as (reply: CommandReply) => void;

    if (!isCommandRequest(raw)) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '';
      reply({ id, ok: false, error: new SocketException('invalid_argument', 'malformed command request').toWire() });
      return;
    }

    if (runtime.running.has(raw.id)) {
      reply({ id: raw.id, ok: false, error: new SocketException('invalid_argument', 'request id already in flight').toWire() });
      return;
    }

    void this.execute(this.createContext(runtime, raw)).then((answer) => this.send(reply, answer, raw.name));
  }

  /** socket.io encodes the ack synchronously, so an unencodable result throws here; answer internal instead of leaving the client to time out. */
  protected send(reply: (reply: CommandReply) => void, answer: CommandReply, name: string): void {
    try {
      reply(answer);
    } catch (err) {
      try {
        reply({ id: answer.id, ok: false, error: this.Errors.toWire(err, `command ${name} reply encoding`) });
      } catch (second) {
        this.Log.error(second as Error, `Socket command ${name}: the error reply could not be sent either`);
      }
    }
  }

  protected createContext(runtime: IConnectionRuntime, request: CommandRequest): SocketCommandContext {
    const ctx = new SocketCommandContext(runtime, request, this.callStorage(runtime.connection, request.name, request.id, request.traceparent));
    ctx.armDeadline(request.deadline);
    return ctx;
  }

  protected onCancel(runtime: IConnectionRuntime, frame: unknown): void {
    if (!isCancelFrame(frame)) {
      return;
    }

    runtime.running.get(frame.id)?.abort(new SocketException('cancelled', `command ${frame.id} cancelled by the client`));
  }

  protected abortRunning(runtime: IConnectionRuntime, reason: SocketException): void {
    for (const ctx of runtime.running.values()) {
      ctx.abort(reason);
    }
  }

  /** The ambient AsyncLocalStorage store of one call; log lines and policies read it. */
  protected callStorage(connection: SocketConnection, call: string, requestId: string = randomUUID(), traceparent?: string): ISocketCallStorage {
    const trace = newTraceContext(traceparent);

    return {
      Principal: connection.principal,
      AuthnPrincipal: connection.authenticated ? connection.principal : null,
      requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      realIp: connection.handshake.address,
      connectionId: connection.id,
      clientId: connection.clientId,
      socketCall: call,
    };
  }

  protected next(ctx: SocketCommandContext, index: number): Promise<unknown> {
    const stage = this.Stages[index];

    if (!stage) {
      return this.invoke(ctx);
    }

    return stage.execute(ctx, () => this.next(ctx, index + 1));
  }

  protected async invoke(ctx: SocketCommandContext): Promise<unknown> {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }

    const handler = ctx.handler;
    const args = ctx.args;

    if (!handler || !args) {
      throw new SocketException('internal', 'command reached its handler without lookup or arguments; a built-in stage is missing');
    }

    return handler.controller[handler.descriptor.Method as string](...args);
  }

  /** W4 replaces the stream branch with real stream replies. */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
    if (isAsyncIterable(result)) {
      try {
        await (result as AsyncGenerator<unknown>).return?.(undefined);
      } catch {
        // a failing generator cleanup does not change the answer
      }
      throw new SocketException('unimplemented', `command ${ctx.request.name} returned a stream; stream replies are not supported by this server version`);
    }

    return { id: ctx.request.id, ok: true, result: result === undefined ? null : result };
  }
}
