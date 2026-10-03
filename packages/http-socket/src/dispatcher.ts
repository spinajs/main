import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Socket } from 'socket.io';
import { AsyncService, Autoinject, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger, newTraceContext } from '@spinajs/log';
import { CommandReply, CommandRequest, ErrorCode, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest, isEventFrame, isStreamCredit } from '@spinajs/http-socket-common';
import { IConnectionRuntime, IRegisteredHandler, ISocketCallContext, ISocketCallStorage, ISocketServerConfig, SocketCommandStage } from './interfaces.js';
import { SocketConnection } from './connection.js';
import { SocketCommandContext } from './context.js';
import { SocketErrorMapper } from './errors.js';
import { TokenBucket, assertHooksConfig, assertLimitsConfig, assertOrderingConfig, assertPayloadSize, assertRate, assertStreamsConfig, untilAborted, withSlot } from './limits.js';
import { SocketHandlerRegistry } from './registry.js';
import { SOCKET_UNKNOWN_COMMAND, observeCommand, observeStream } from './metrics.js';
import { SocketArgumentResolver } from './args.js';
import { SocketPolicyGate } from './policies.js';
import { SocketPrincipalGuard } from './principal-guard.js';
import { ServerStream, StreamOutcome, isStreamResult } from './stream.js';
import { IN_FLIGHT_RETRY_AFTER_MS } from './stages/limits.js';
import './stages/index.js';

/** At most one warn per connection in this window about dropped events and command frames; the rest go to debug. */
export const EVENT_WARN_WINDOW_MS = 10_000;

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Packets engine.io holds for the connection's transport; it has no public gauge, so this reads its private write buffer. */
function unsentPackets(socket: Socket): number {
  return (socket.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0;
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
  protected Registry: SocketHandlerRegistry;

  @Autoinject()
  protected Arguments: SocketArgumentResolver;

  @Autoinject()
  protected Gate: SocketPolicyGate;

  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  @Autoinject()
  protected Als: AsyncLocalStorage<ISocketCallStorage>;

  protected Stages: SocketCommandStage[] = [];

  protected runtimes = new Map<string, IConnectionRuntime>();

  /** the socket of each runtime, which stream frames are written to */
  protected sockets = new WeakMap<IConnectionRuntime, Socket>();
  protected drainListeners = new WeakMap<Socket, Set<() => void>>();

  public async resolve(): Promise<void> {
    await super.resolve();
    assertLimitsConfig(this.Options);
    assertOrderingConfig(this.Options);
    assertHooksConfig(this.Options);
    assertStreamsConfig(this.Options);
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    this.Stages = [...stages].sort((a, b) => a.Order - b.Order);
  }

  /** @internal called by SocketServer */
  public attach(connection: SocketConnection, socket: Socket): IConnectionRuntime {
    const runtime: IConnectionRuntime = {
      connection,
      bucket: new TokenBucket(this.Options.rate.perSecond, this.Options.rate.burst),
      inFlight: 0,
      eventsInFlight: 0,
      streams: 0,
      running: new Map(),
      ready: Promise.resolve(),
    };

    this.runtimes.set(connection.id, runtime);
    this.sockets.set(runtime, socket);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));
    socket.on(WIRE_EVENTS.credit, (frame: unknown) => this.onCredit(runtime, frame));
    socket.on(WIRE_EVENTS.event, (frame: unknown) => {
      this.onEvent(runtime, frame).catch((err: Error) => this.Log.error(err, `Socket event from connection ${connection.id} failed outside its handler`));
    });
    runtime.ready = this.connectHooks(runtime);

    return runtime;
  }

  /** @internal called by SocketServer */
  public detach(connection: SocketConnection, reason: string): void {
    const runtime = this.runtimes.get(connection.id);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(connection.id);
    this.abortRunning(runtime, new SocketException('unavailable', 'connection closed'));
    // a client that leaves while its connect hooks still run gets its disconnect hooks after them
    void runtime.ready.then(() => this.runHooks(runtime, 'disconnect', reason)).catch((err: Error) => this.Log.error(err, `Socket disconnect hooks of connection ${connection.id} failed`));
  }

  /** @internal Aborts every running command on every connection ( shutdown ). */
  public abortAll(reason: SocketException): void {
    for (const runtime of this.runtimes.values()) {
      this.abortRunning(runtime, reason);
    }
  }

  /** Runs one command through the stages and the handler; never rejects. */
  public async execute(ctx: SocketCommandContext): Promise<CommandReply> {
    const runtime = ctx.runtime;
    const started = performance.now();
    runtime.running.set(ctx.request.id, ctx);

    let reply: CommandReply;

    try {
      // D14: stages, hydrators and the handler all see the principal ( AuthzService.current() once F4 lands )
      const chain = this.Als.run(ctx.storage, () => this.next(ctx, 0));
      // An abort answers at once; the chain keeps running ( and holds its in-flight slot ) until the handler settles.
      chain.catch(() => undefined);
      const abort = aborted(ctx.signal);
      abort.catch(() => undefined);

      let result: unknown;
      try {
        result = await Promise.race([chain, abort]);
      } catch (err) {
        // the answer is out already; a stream the handler returns later is closed instead of left open
        void chain.then((late) => this.closeStream(late), () => undefined);
        throw err;
      }
      reply = await this.toReply(ctx, result);
    } catch (err) {
      reply = { id: ctx.request.id, ok: false, error: this.Errors.toWire(err, `command ${ctx.request.name}`) };
    } finally {
      ctx.dispose();
      // an open stream keeps its id until it ends, so cancel, credit, disconnect and shutdown still find it
      if (!ctx.stream && runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
    }

    this.observe(ctx, reply, performance.now() - started);
    return reply;
  }

  protected observe(ctx: SocketCommandContext, reply: CommandReply, ms: number): void {
    const code = reply.ok ? 'ok' : reply.error.code;

    // observability must never turn into a missing reply
    try {
      this.Log.debug(`socket command ${ctx.request.name} ${code} ${Math.round(ms)}ms connection ${ctx.connection.id}`);
      // only registered names are labels; a refusal before lookup still resolves the name here
      observeCommand((ctx.handler ?? this.Registry.command(ctx.request.name))?.fullName ?? SOCKET_UNKNOWN_COMMAND, code, ms / 1000);
    } catch {
      // swallowed on purpose
    }
  }

  /** Refusals answered before `execute`. */
  protected observeRefused(name: string | null, code: ErrorCode): void {
    try {
      observeCommand((name !== null ? this.Registry.command(name)?.fullName : undefined) ?? SOCKET_UNKNOWN_COMMAND, code, 0);
    } catch {
      // swallowed on purpose
    }
  }

  protected onCommand(runtime: IConnectionRuntime, raw: unknown, ack: unknown): void {
    // first: every frame costs a token, so no refusal or log line below comes for free
    let limited: unknown = null;
    try {
      assertRate(runtime.bucket);
    } catch (err) {
      limited = err;
    }

    if (typeof ack !== 'function') {
      if (limited === null) {
        this.windowed(runtime, `Socket command without an ack callback from connection ${runtime.connection.id}, ignored`);
      }
      return;
    }

    const reply = ack as (reply: CommandReply) => void;

    if (!isCommandRequest(raw)) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '';
      this.refuse(reply, id, null, limited ?? new SocketException('invalid_argument', 'malformed command request'));
      return;
    }

    if (runtime.running.has(raw.id)) {
      this.refuse(reply, raw.id, raw.name, limited ?? new SocketException('invalid_argument', 'request id already in flight'));
      return;
    }

    const ctx = this.createContext(runtime, raw);
    if (limited !== null) {
      // answered by the rate stage, so the size stage still comes first ( spec §5.2 )
      ctx.rateRefusal = limited;
    }
    void this.execute(ctx).then((answer) => {
      this.send(reply, answer, raw.name);
      // after the ack, so the client knows the id is a stream before its first chunk
      if (ctx.stream) {
        this.runStream(ctx, ctx.stream);
      }
    });
  }

  protected refuse(reply: (reply: CommandReply) => void, id: string, name: string | null, err: unknown): void {
    const error = this.Errors.toWire(err, name === null ? 'command' : `command ${name}`);
    this.observeRefused(name, error.code);
    reply({ id, ok: false, error });
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

  protected onCredit(runtime: IConnectionRuntime, frame: unknown): void {
    if (!isStreamCredit(frame)) {
      return;
    }

    const ctx = runtime.running.get(frame.id);
    if (ctx instanceof SocketCommandContext) {
      ctx.stream?.grant(frame.credits);
    }
  }

  /** Fire-and-forget: a refused or failing event is logged and dropped, the socket stays up unless its principal check fails ( D16 ). */
  protected async onEvent(runtime: IConnectionRuntime, frame: unknown): Promise<void> {
    const connection = runtime.connection;

    if (!isEventFrame(frame)) {
      this.Log.debug(`Malformed socket event from connection ${connection.id}, dropped`);
      return;
    }

    try {
      // before waiting for the connect hooks, so a flood sent while they run is not queued
      assertPayloadSize(frame.payload, this.Options.maxPayloadBytes);
      assertRate(runtime.bucket);

      await withSlot(runtime, 'eventsInFlight', 'events', this.Options.maxInFlightEventsPerConnection, () => this.runEvent(runtime, frame.name, frame.payload));
    } catch (err) {
      // a disconnect that ended the wait for the connect hooks is not a failure worth a line
      if (err !== connection.signal.reason || !connection.signal.aborted) {
        this.dropped(runtime, frame.name, err);
      }
    }
  }

  protected async runEvent(runtime: IConnectionRuntime, name: string, payload: unknown): Promise<void> {
    const connection = runtime.connection;

    // a disconnect frees the slot and drops the event while the connect hooks still run
    await untilAborted(runtime.ready, connection.signal);
    // closes the connection itself when the principal is no longer valid
    await this.Guard.ensure(connection);

    const handler = this.Registry.event(name);
    if (!handler) {
      this.Log.debug(`Unknown socket event ${name} from connection ${connection.id}, dropped`);
      return;
    }

    // built after ensure(): a revalidation may have adopted a renewed principal
    const ctx: ISocketCallContext = { kind: 'event', connection, handler, payload, signal: connection.signal, storage: this.callStorage(connection, name) };
    await this.Als.run(ctx.storage, () => this.Gate.check(ctx));
    await this.call(ctx, handler);
  }

  /** A client can make every event fail, so refusals must not turn into one warn each. */
  protected dropped(runtime: IConnectionRuntime, name: string, err: unknown): void {
    const wire = this.Errors.toWire(err, `event ${name}`);
    this.windowed(runtime, `Socket event ${name} from connection ${runtime.connection.id} dropped: ${wire.code} ${wire.message}`, wire.code === 'resource_exhausted' || wire.code === 'unauthenticated');
  }

  /** At most one warn per connection in EVENT_WARN_WINDOW_MS; the other lines, and every `quiet` one, go to debug. */
  protected windowed(runtime: IConnectionRuntime, line: string, quiet = false): void {
    const now = Date.now();

    if (quiet || now - (runtime.warnedAt ?? Number.NEGATIVE_INFINITY) < EVENT_WARN_WINDOW_MS) {
      this.Log.debug(line);
      return;
    }

    runtime.warnedAt = now;
    this.Log.warn(line);
  }

  protected connectHooks(runtime: IConnectionRuntime): Promise<void> {
    const id = runtime.connection.id;
    const ms = this.Options.hooks.connectTimeoutMs;
    const hooks = this.runHooks(runtime, 'connect').catch((err: Error) => this.Log.error(err, `Socket connect hooks of connection ${id} failed`));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (this.runtimes.get(id) === runtime) {
          this.Log.error(`Socket connect hooks of connection ${id} still running after ${ms} ms; its commands and events no longer wait for them`);
        }
        resolve();
      }, ms);
      timer.unref?.();
    });

    return Promise.race([hooks, timeout]).finally(() => clearTimeout(timer));
  }

  /** Hooks run in registration order and no policies ( D9 ); a throwing hook is logged and never refuses the connection. */
  protected async runHooks(runtime: IConnectionRuntime, kind: 'connect' | 'disconnect', reason?: string): Promise<void> {
    const connection = runtime.connection;
    // the connection's signal is already aborted when the disconnect hooks start
    const signal = kind === 'connect' ? connection.signal : new AbortController().signal;

    for (const handler of this.Registry.hooks(kind)) {
      try {
        const ctx: ISocketCallContext = { kind, connection, handler, payload: undefined, signal, reason, storage: this.callStorage(connection, handler.fullName) };
        await this.call(ctx, handler);
      } catch (err) {
        const wire = this.Errors.toWire(err, `${kind} hook ${handler.fullName}`);
        this.Log.warn(`Socket ${kind} hook ${handler.fullName} failed for connection ${connection.id}: ${wire.code} ${wire.message}`);
      }
    }
  }

  /** Arguments and the handler of an event or a hook, inside the call's store ( D14 ). */
  protected call(ctx: ISocketCallContext, handler: IRegisteredHandler): Promise<unknown> {
    return this.Als.run(ctx.storage, async () => {
      const args = await this.Arguments.resolve(ctx);
      return handler.controller[handler.descriptor.Method as string](...args);
    });
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

  /** An async iterable result becomes a stream reply; its chunks follow the ack ( runStream ). */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
    if (!isStreamResult(result)) {
      return { id: ctx.request.id, ok: true, result: result === undefined ? null : result };
    }

    try {
      ctx.stream = this.openStream(ctx, result);
    } catch (err) {
      await this.closeStream(result);
      throw err;
    }

    return { id: ctx.request.id, ok: true, stream: true };
  }

  /** Closes a stream result that will never be sent; a no-op for anything else. */
  protected async closeStream(result: unknown): Promise<void> {
    if (!isStreamResult(result)) {
      return;
    }

    try {
      await result[Symbol.asyncIterator]().return?.(undefined);
    } catch {
      // a failing cleanup does not change the answer
    }
  }

  protected openStream(ctx: SocketCommandContext, source: AsyncIterable<unknown>): ServerStream {
    const name = ctx.request.name;
    const credits = ctx.request.credits;
    const limits = this.Options.streams;
    const runtime = ctx.runtime;
    const socket = this.sockets.get(runtime)!;

    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }

    // the queue place is released when the handler returns, long before the stream ends; the registry refuses async generators
    if (ctx.handler?.descriptor.Options.ordered) {
      throw new SocketException('failed_precondition', `ordered command ${name} cannot reply with a stream`);
    }

    if (credits === undefined) {
      throw new SocketException('failed_precondition', `command ${name} replies with a stream; open it as a stream with credits`);
    }

    if (credits > limits.maxCredits) {
      throw new SocketException('invalid_argument', `stream credit above the limit of ${limits.maxCredits} chunks`, { details: { limit: limits.maxCredits } });
    }

    if (runtime.streams >= limits.maxPerConnection) {
      throw new SocketException('resource_exhausted', `more than ${limits.maxPerConnection} streams open on this connection`, { retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS });
    }

    const stream = new ServerStream({
      id: ctx.request.id,
      name,
      iterator: this.Als.run(ctx.storage, () => source[Symbol.asyncIterator]()),
      signal: ctx.signal,
      abort: (reason) => ctx.abort(reason),
      credits,
      maxCredits: limits.maxCredits,
      stallTimeoutMs: limits.stallTimeoutMs,
      send: (event, frame) => {
        socket.emit(event, frame);
      },
      within: (step) => this.Als.run(ctx.storage, step),
      toWire: (err) => this.Errors.toWire(err, `stream ${name}`),
      // a client that grants credit blind but never reads its socket would otherwise grow engine.io's write buffer without bound
      backlogged: () => unsentPackets(socket) > limits.maxCredits,
      onDrain: (listener) => this.onDrain(socket, listener),
    });

    runtime.streams++;
    return stream;
  }

  /** One engine.io listener per socket, however many streams wait on it: maxPerConnection may exceed the emitter's leak warning limit. */
  protected onDrain(socket: Socket, listener: () => void): () => void {
    let listeners = this.drainListeners.get(socket);
    if (!listeners) {
      const all = new Set<() => void>();
      socket.conn.on('drain', () => [...all].forEach((waiting) => waiting()));
      this.drainListeners.set(socket, (listeners = all));
    }

    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  protected runStream(ctx: SocketCommandContext, stream: ServerStream): void {
    const runtime = ctx.runtime;
    const started = performance.now();

    void stream.run().then((outcome) => {
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
      this.streamEnded(ctx, stream, outcome, performance.now() - started);
    });
    // a source that ignores its signal still runs, so it keeps its slot until it settles
    void stream.settled.then(() => runtime.streams--);
  }

  protected streamEnded(ctx: SocketCommandContext, stream: ServerStream, outcome: StreamOutcome, ms: number): void {
    // observability must never break the stream bookkeeping
    try {
      this.Log.debug(`socket stream ${ctx.request.name} ${outcome} ${stream.sent} chunks ${Math.round(ms)}ms connection ${ctx.connection.id}`);
      observeStream(ctx.handler?.fullName ?? SOCKET_UNKNOWN_COMMAND, outcome);
    } catch {
      // swallowed on purpose
    }
  }
}
