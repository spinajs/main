import { SocketException, WIRE_EVENTS, type ContractShape, type EventFrame, type SocketContract, type SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher, DEFAULT_TIMEOUT_MS, type CommandOptions } from './commands.js';
import { Connection, type AuthProvider, type ConnectionState, type IoOptions } from './connection.js';
import type { TypedSocketClient } from './contract.js';
import { DurableQueue, type AckedCommand, type DurableCommandOptions, type DurableOptions, type FailedCommand, type HeldCommand } from './durable.js';
import { Emitter, rethrowAsync } from './emitter.js';
import { randomId } from './ids.js';
import { MemoryOutboxStore, type OutboxStore } from './outbox.js';
import type { ReconnectOptions } from './reconnect.js';

export interface SocketClientOptions {
  /** Server origin; a path in it selects a socket.io namespace. */
  url: string;
  /** socket.io endpoint path (socket.io's default: '/socket.io'). */
  path?: string;
  /** Asked on every (re)connect; its fields go into the handshake. */
  auth?: AuthProvider;
  /** Stable per install, persisted by the app; 1 to MAX_ID_LENGTH printable ASCII characters. Generated when omitted. */
  clientId?: string;
  reconnect?: Partial<ReconnectOptions>;
  defaultTimeoutMs?: number;
  connectTimeoutMs?: number;
  autoConnect?: boolean;
  /** Passed to socket.io-client; reconnection, autoConnect, forceNew, retries and auth stay owned by the client. */
  io?: IoOptions;
  /**
   * Where durable commands wait for their reply. The MemoryOutboxStore default does not survive a reload: browsers pass
   * IndexedDbOutboxStore ( `/browser` ), Node passes FileOutboxStore ( `/node` ). Requires an explicit `clientId`.
   */
  outbox?: OutboxStore;
  durable?: DurableOptions;
  onListenerError?: (error: unknown) => void;
}

export interface ClientLifecycleEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  auth_required: (error: SocketError) => void;
  incompatible: (error: SocketError) => void;
  /** The server refused the connection for a reason no retry can fix (forbidden, invalid_argument …); connect() tries again. */
  refused: (error: SocketError) => void;
  /** A durable command was acknowledged; also for commands resumed from the outbox after a reload. In send order. */
  acked: (event: AckedCommand) => void;
  /** A durable command the server refused for good; it is in the outbox's failed list. In send order. */
  failed: (event: FailedCommand) => void;
  /** A durable command was refused as unauthenticated and stays queued; the queue sends nothing until the connection comes online again. */
  held: (event: HeldCommand) => void;
}

export type LifecycleEventName = keyof ClientLifecycleEvents;

/** Names `on()` routes to client lifecycle listeners; server events with these names are unreachable. */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set<LifecycleEventName>(['state', 'auth_required', 'incompatible', 'refused', 'acked', 'failed', 'held']);

export type ServerEventListener<T = unknown> = (payload: T) => void;
export type Unsubscribe = () => void;

type AnyListener = (...args: any[]) => void;
type ServerEvents = Record<string, ServerEventListener>;

function isLifecycleEvent(event: string): event is LifecycleEventName {
  return LIFECYCLE_EVENTS.has(event);
}

export class SocketClient {
  public readonly clientId: string;
  private readonly connection: Connection;
  private readonly commands: CommandDispatcher;
  private readonly durableQueue: DurableQueue;
  private readonly lifecycle: Emitter<ClientLifecycleEvents>;
  private readonly serverEvents: Emitter<ServerEvents>;
  // set once the app calls connect(), disconnect() or close(), which then override autoConnect
  private controlled = false;

  constructor(options: SocketClientOptions) {
    const onListenerError = options.onListenerError ?? rethrowAsync;
    // persisted keys are `${clientId}:…`: a fresh random id after a reload would break exactly-once and ordering
    if (options.outbox !== undefined && options.clientId === undefined) {
      throw new RangeError('an outbox requires a stable clientId, persisted by the app');
    }
    this.clientId = options.clientId ?? randomId();
    this.lifecycle = new Emitter<ClientLifecycleEvents>(onListenerError);
    this.serverEvents = new Emitter<ServerEvents>(onListenerError);
    this.connection = new Connection({
      url: options.url,
      path: options.path,
      clientId: this.clientId,
      auth: options.auth,
      reconnect: options.reconnect,
      connectTimeoutMs: options.connectTimeoutMs,
      io: options.io,
      onListenerError,
    });
    this.commands = new CommandDispatcher(this.connection, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.durableQueue = new DurableQueue({
      connection: this.connection,
      commands: this.commands,
      store: options.outbox ?? new MemoryOutboxStore(),
      clientId: this.clientId,
      reconnect: options.reconnect,
      durable: options.durable,
      onListenerError,
    });
    this.durableQueue.events.on('acked', (event) => this.lifecycle.emit('acked', event));
    this.durableQueue.events.on('failed', (event) => this.lifecycle.emit('failed', event));
    this.durableQueue.events.on('held', (event) => this.lifecycle.emit('held', event));

    this.connection.events.on('state', (state, previous) => this.lifecycle.emit('state', state, previous));
    this.connection.events.on('auth_required', (error) => this.lifecycle.emit('auth_required', error));
    this.connection.events.on('incompatible', (error) => this.lifecycle.emit('incompatible', error));
    this.connection.events.on('refused', (error) => this.lifecycle.emit('refused', error));
    this.connection.listen(WIRE_EVENTS.event, (frame: EventFrame) => {
      if (typeof frame?.name === 'string') this.serverEvents.emit(frame.name, frame.payload);
    });

    // a microtask, so listeners attached right after construction still see 'connecting'
    if (options.autoConnect !== false) queueMicrotask(() => this.autoConnect());
  }

  private autoConnect(): void {
    if (!this.controlled) this.connection.connect();
  }

  public get state(): ConnectionState {
    return this.connection.state;
  }

  public connect(): void {
    this.controlled = true;
    this.connection.connect();
  }

  /** Goes offline and stops reconnecting until connect(). */
  public disconnect(): void {
    this.controlled = true;
    this.connection.disconnect();
  }

  /** Terminal: rejects pending commands and releases the socket. */
  public close(): void {
    this.controlled = true;
    this.connection.close();
  }

  /** The same client, typed by a contract shared with the server; no runtime cost. */
  public typed<C extends ContractShape>(_contract: SocketContract<C>): TypedSocketClient<C> {
    return this as unknown as TypedSocketClient<C>;
  }

  public command<R = unknown>(name: string, payload?: unknown, options?: CommandOptions): Promise<R> {
    return this.commands.execute(name, payload, options) as Promise<R>;
  }

  /**
   * Persisted, ordered and retried until the server answers ( spec §6 ); the server command must be idempotent and ordered: 'client'.
   * With the default MemoryOutboxStore the queue is lost on reload; pass `outbox` ( IndexedDbOutboxStore in browsers, FileOutboxStore in Node ) to keep it.
   */
  public durable<R = unknown>(name: string, payload?: unknown, options?: DurableCommandOptions): Promise<R> {
    return this.durableQueue.submit(name, payload, options) as Promise<R>;
  }

  /** Reserved: stream replies arrive with credit-based flow control. */
  public stream<T = unknown>(name: string, _payload?: unknown, _options?: CommandOptions): AsyncIterable<T> {
    const error = new SocketException('unimplemented', `stream() is not available yet (${name})`);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(error),
      }),
    };
  }

  /** Fire-and-forget event to the server; returns false and drops it when not online. */
  public emit(name: string, payload?: unknown): boolean {
    const frame: EventFrame = { name, payload };
    return this.connection.send(WIRE_EVENTS.event, frame);
  }

  public on<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  public on<T = unknown>(event: string, listener: ServerEventListener<T>): Unsubscribe;
  public on(event: string, listener: AnyListener): Unsubscribe {
    return isLifecycleEvent(event) ? this.lifecycle.on(event, listener) : this.serverEvents.on(event, listener);
  }

  public once<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  public once<T = unknown>(event: string, listener: ServerEventListener<T>): Unsubscribe;
  public once(event: string, listener: AnyListener): Unsubscribe {
    return isLifecycleEvent(event) ? this.lifecycle.once(event, listener) : this.serverEvents.once(event, listener);
  }

  public off<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): void;
  public off<T = unknown>(event: string, listener: ServerEventListener<T>): void;
  public off(event: string, listener: AnyListener): void {
    if (isLifecycleEvent(event)) this.lifecycle.off(event, listener);
    else this.serverEvents.off(event, listener);
  }
}
