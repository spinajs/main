import type { Socket } from 'socket.io';
import { WIRE_EVENTS, isCancelFrame, isSocketError, type Chunk, type CommandReply, type CommandRequest, type StreamCredit, type StreamEnd, type StreamFail } from '@spinajs/http-socket-common';
import type { StubServer } from './stub-server.js';

export type StubStreamSource = (payload: any, request: CommandRequest) => Iterable<unknown> | AsyncIterable<unknown>;

export interface StubStreamLog {
  readonly request: CommandRequest;
  /** credit frames received, in order */
  readonly credits: number[];
  sent: number;
  cancelled: boolean;
}

/**
 * Serves `name` as a stream reply the way the W4 server does: the ack `{ stream: true }`, then one
 * chunk per unit of credit ( the source is asked for an item only with credit in hand ), then `end`,
 * or `fail` when the source throws a SocketError.
 */
export function serveStream(server: StubServer, name: string, source: StubStreamSource): StubStreamLog[] {
  const logs: StubStreamLog[] = [];

  server.rawReplies.set(name, (request, socket) => {
    const log: StubStreamLog = { request, credits: [], sent: 0, cancelled: false };
    logs.push(log);
    // after the ack, which the stub writes once this function has returned
    setTimeout(() => void pump(socket, request, source, log), 0);
    const reply: CommandReply = { id: request.id, ok: true, stream: true };
    return reply;
  });

  return logs;
}

async function pump(socket: Socket, request: CommandRequest, source: StubStreamSource, log: StubStreamLog): Promise<void> {
  let credit = request.credits ?? 0;
  let wake: (() => void) | null = null;
  const onCredit = (frame: StreamCredit) => {
    if (frame?.id !== request.id) return;
    log.credits.push(frame.credits);
    credit += frame.credits;
    wake?.();
  };
  const onCancel = (frame: unknown) => {
    if (!isCancelFrame(frame) || frame.id !== request.id) return;
    log.cancelled = true;
    wake?.();
  };
  const onDisconnect = () => wake?.();
  socket.on(WIRE_EVENTS.credit, onCredit);
  socket.on(WIRE_EVENTS.cancel, onCancel);
  socket.on('disconnect', onDisconnect);

  try {
    const items = source(request.payload, request);
    const iterator = (Symbol.asyncIterator in items ? (items as AsyncIterable<unknown>)[Symbol.asyncIterator]() : (items as Iterable<unknown>)[Symbol.iterator]()) as AsyncIterator<unknown> | Iterator<unknown>;

    for (;;) {
      while (credit === 0 && !log.cancelled && socket.connected) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      if (log.cancelled || !socket.connected) return;

      const step = await iterator.next();
      if (log.cancelled || !socket.connected) return;
      if (step.done) {
        const end: StreamEnd = { id: request.id, seq: log.sent };
        socket.emit(WIRE_EVENTS.end, end);
        return;
      }

      const chunk: Chunk = { id: request.id, seq: log.sent, data: step.value };
      socket.emit(WIRE_EVENTS.chunk, chunk);
      log.sent++;
      credit--;
    }
  } catch (error) {
    const fail: StreamFail = { id: request.id, error: isSocketError(error) ? error : { code: 'internal', message: 'stream source failed', retryable: false } };
    socket.emit(WIRE_EVENTS.fail, fail);
  } finally {
    socket.off(WIRE_EVENTS.credit, onCredit);
    socket.off(WIRE_EVENTS.cancel, onCancel);
    socket.off('disconnect', onDisconnect);
  }
}

export function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

export function* endless(): Generator<number> {
  for (let i = 0; ; i++) yield i;
}
