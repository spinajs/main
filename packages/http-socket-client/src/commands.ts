import { SocketException, WIRE_EVENTS, isSocketError, type CancelFrame, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import type { Connection, ConnectionState } from './connection.js';
import { assertTimeoutMs } from './timeout.js';

export type WhenOffline = 'fail' | 'wait';

export interface CommandOptions {
  /** Budget for the whole call: the wait for a connection (whenOffline 'wait') and for the reply. */
  timeoutMs?: number;
  signal?: AbortSignal;
  whenOffline?: WhenOffline;
  /** W3C trace context, carried into the server handler. */
  traceparent?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed', retryable: false };
const OFFLINE: SocketError = { code: 'unavailable', message: 'the client is offline', retryable: true };
const STAYED_OFFLINE: SocketError = { code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true };
const CONNECTION_LOST: SocketError = { code: 'unavailable', message: 'the connection dropped before the reply', retryable: true };
const NO_REPLY: SocketError = { code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true };
const CANCELLED: SocketError = { code: 'cancelled', message: 'the command was cancelled', retryable: false };
const STREAM_REPLY: SocketError = { code: 'failed_precondition', message: 'the command replies with a stream; use stream()', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };

type Timer = ReturnType<typeof setTimeout>;

interface PendingCommand {
  readonly request: CommandRequest;
  readonly deadlineAt: number;
  sent: boolean;
  done: boolean;
  resolve(value: unknown): void;
  reject(error: SocketException): void;
  dispose(): void;
}

/** Plain (non-durable) commands: one attempt each, never re-sent. */
export class CommandDispatcher {
  private seq = 0;
  // insertion-ordered, so commands held while offline go out in call order
  private readonly waiting = new Set<PendingCommand>();
  private readonly inFlight = new Set<PendingCommand>();

  constructor(private readonly connection: Connection, private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    assertTimeoutMs('defaultTimeoutMs', defaultTimeoutMs);
    connection.events.on('state', (state, previous) => this.onState(state, previous));
  }

  /** Unique per client instance; durable and stream requests take ids from here too. */
  public nextId(): string {
    return (++this.seq).toString(36);
  }

  public execute(name: string, payload: unknown, options: CommandOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      assertTimeoutMs('timeoutMs', timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.connection.state === 'closed') return rejected(CLOSED);
    if (options.signal?.aborted) return rejected(CANCELLED);
    if (!this.connection.connected && (options.whenOffline ?? 'fail') === 'fail') return rejected(OFFLINE);

    const request: CommandRequest = { id: this.nextId(), name, payload };
    if (options.traceparent !== undefined) request.traceparent = options.traceparent;
    const signal = options.signal;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (command.sent) {
          const cancel: CancelFrame = { id: request.id };
          this.connection.send(WIRE_EVENTS.cancel, cancel);
        }
        this.fail(command, CANCELLED);
      };
      const timer: Timer = setTimeout(() => this.fail(command, command.sent ? NO_REPLY : STAYED_OFFLINE), timeoutMs);
      const command: PendingCommand = {
        request,
        deadlineAt: Date.now() + timeoutMs,
        sent: false,
        done: false,
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (this.connection.connected) this.transmit(command);
      else this.waiting.add(command);
    });
  }

  private transmit(command: PendingCommand): void {
    this.waiting.delete(command);
    // relative, so client/server clock skew cannot expire it; the server ignores a deadline <= 0
    command.request.deadline = Math.max(1, command.deadlineAt - Date.now());
    command.sent = true;
    this.inFlight.add(command);
    const sent = this.connection.request<CommandReply>(WIRE_EVENTS.command, command.request, (reply) => this.onReply(command, reply));
    if (!sent) this.fail(command, CONNECTION_LOST);
  }

  private onReply(command: PendingCommand, reply: CommandReply): void {
    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') return this.fail(command, MALFORMED_REPLY);
    if (!reply.ok) return this.fail(command, isSocketError(reply.error) ? reply.error : MALFORMED_REPLY);
    // a CommandStreamReply: the result follows as stream frames, which only stream() consumes
    if ('stream' in reply) return this.fail(command, STREAM_REPLY);
    this.succeed(command, reply.result);
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      for (const command of [...this.waiting, ...this.inFlight]) this.fail(command, CLOSED);
      return;
    }
    if (previous === 'online') for (const command of [...this.inFlight]) this.fail(command, CONNECTION_LOST);
    if (state === 'online') for (const command of [...this.waiting]) this.transmit(command);
  }

  private succeed(command: PendingCommand, value: unknown): void {
    if (this.finish(command)) command.resolve(value);
  }

  private fail(command: PendingCommand, error: SocketError): void {
    if (this.finish(command)) command.reject(SocketException.fromWire(error));
  }

  private finish(command: PendingCommand): boolean {
    if (command.done) return false;
    command.done = true;
    command.dispose();
    this.waiting.delete(command);
    this.inFlight.delete(command);
    return true;
  }
}

function rejected(error: SocketError): Promise<never> {
  return Promise.reject(SocketException.fromWire(error));
}
