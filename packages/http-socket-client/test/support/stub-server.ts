import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import {
  PROTOCOL_VERSION,
  SYSTEM_EVENTS,
  WIRE_EVENTS,
  isCancelFrame,
  isSocketError,
  type CommandReply,
  type CommandRequest,
  type DisconnectNotice,
  type EventFrame,
  type Handshake,
  type ShutdownNotice,
  type SocketError,
} from '@spinajs/http-socket-common';

export type CommandHandler = (payload: any, request: CommandRequest, socket: Socket) => unknown;
export type RawReply = (request: CommandRequest) => unknown;
export type AckFault = { kind: 'none' } | { kind: 'drop' } | { kind: 'delay'; ms: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A socket.io server that answers like the W1 server (W1 plan, "Coordination with W2"), with fault
 * injection. Not the W1 server: the client tests must not depend on W1 being built.
 */
export class StubServer {
  public port = 0;
  public readonly handshakes: Handshake[] = [];
  public readonly requests: CommandRequest[] = [];
  public readonly cancels: string[] = [];
  public readonly clientEvents: EventFrame[] = [];
  public readonly handlers = new Map<string, CommandHandler>();
  public readonly rawReplies = new Map<string, RawReply>();
  public refuse: ((handshake: Handshake) => SocketError | undefined) | undefined;
  public holdHandshakes = false;
  public ackFault: AckFault = { kind: 'none' };
  private io: Server | undefined;

  public get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public get connectionCount(): number {
    return this.io ? this.io.sockets.sockets.size : 0;
  }

  public async start(port = this.port): Promise<void> {
    const http = createServer();
    const io = new Server(http);

    io.use((socket, next) => {
      const handshake = socket.handshake.auth as Handshake;
      this.handshakes.push(handshake);
      if (this.holdHandshakes) return;
      const refusal: SocketError | undefined =
        handshake.protocol !== PROTOCOL_VERSION
          ? { code: 'version_mismatch', message: `server speaks protocol ${PROTOCOL_VERSION}`, retryable: false, details: { server: PROTOCOL_VERSION } }
          : this.refuse?.(handshake);
      if (refusal) {
        const error = new Error(refusal.message) as Error & { data?: SocketError };
        error.data = refusal;
        next(error);
        return;
      }
      next();
    });

    io.on('connection', (socket) => {
      socket.on(WIRE_EVENTS.command, (request: CommandRequest, ack: (reply: unknown) => void) => {
        this.requests.push(request);
        void this.reply(request, socket, ack);
      });
      socket.on(WIRE_EVENTS.cancel, (frame: unknown) => {
        if (isCancelFrame(frame)) this.cancels.push(frame.id);
      });
      socket.on(WIRE_EVENTS.event, (frame: EventFrame) => {
        this.clientEvents.push(frame);
      });
    });

    await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', () => resolve()));
    this.port = (http.address() as AddressInfo).port;
    this.io = io;
  }

  public async stop(): Promise<void> {
    const io = this.io;
    if (!io) return;
    this.io = undefined;
    // io.close() also closes the attached http server
    await new Promise<void>((resolve) => {
      void io.close(() => resolve());
    });
  }

  public async restart(downMs = 0): Promise<void> {
    const port = this.port;
    await this.stop();
    if (downMs > 0) await sleep(downMs);
    await this.start(port);
  }

  /** Kills every engine.io connection without a socket.io DISCONNECT, as a network drop would. */
  public killConnections(): void {
    for (const socket of this.io?.sockets.sockets.values() ?? []) socket.conn.close();
  }

  /** What W1's `SocketHub.disconnect` does: the notice, then a server-side disconnect. */
  public kick(reason: string): void {
    const notice: DisconnectNotice = { reason };
    this.emitEvent(SYSTEM_EVENTS.disconnect, notice);
    this.io?.disconnectSockets(false);
  }

  public emitEvent(name: string, payload: unknown): void {
    const frame: EventFrame = { name, payload };
    this.io?.emit(WIRE_EVENTS.event, frame);
  }

  public announceShutdown(retryAfterMs: number): void {
    const notice: ShutdownNotice = { retryAfterMs };
    this.emitEvent(SYSTEM_EVENTS.shutdown, notice);
  }

  private async reply(request: CommandRequest, socket: Socket, ack: (reply: unknown) => void): Promise<void> {
    const reply = await this.buildReply(request, socket);
    const fault = this.ackFault;
    if (fault.kind === 'drop') return;
    if (fault.kind === 'delay') await sleep(fault.ms);
    ack(reply);
  }

  private async buildReply(request: CommandRequest, socket: Socket): Promise<unknown> {
    const raw = this.rawReplies.get(request.name);
    if (raw) return raw(request);

    const handler = this.handlers.get(request.name);
    if (!handler) {
      const unknown: CommandReply = { id: request.id, ok: false, error: { code: 'unimplemented', message: `unknown command ${request.name}`, retryable: false } };
      return unknown;
    }
    try {
      const result = await handler(request.payload, request, socket);
      // as W1 does: a handler that returns nothing answers result: null, never a missing field
      const done: CommandReply = { id: request.id, ok: true, result: result === undefined ? null : result };
      return done;
    } catch (error) {
      const failed: CommandReply = { id: request.id, ok: false, error: isSocketError(error) ? error : { code: 'internal', message: 'handler failed', retryable: false } };
      return failed;
    }
  }
}
