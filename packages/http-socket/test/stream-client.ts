import { Socket as ClientSocket } from 'socket.io-client';
import { CancelFrame, Chunk, CommandReply, CommandRequest, StreamCredit, StreamEnd, StreamFail, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { nextId } from './harness.js';

/** One stream command driven by hand over a raw socket.io client: the test grants credit and cancels. */
export interface IRawStream {
  readonly id: string;
  readonly reply: Promise<CommandReply>;
  readonly chunks: Chunk[];
  readonly end: StreamEnd | null;
  readonly fail: StreamFail | null;
  /** settles on the `end` or `fail` frame */
  readonly finished: Promise<void>;
  grant(credits: number): void;
  cancel(): void;
}

/** @param credits - the request's initial window; undefined sends a request without it */
export function rawStream(socket: ClientSocket, name: string, payload: unknown, credits: number | undefined, extra: Partial<CommandRequest> = {}): IRawStream {
  const id = extra.id ?? nextId();
  const chunks: Chunk[] = [];
  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const state = { end: null as StreamEnd | null, fail: null as StreamFail | null };
  const onChunk = (frame: Chunk) => {
    if (frame.id === id) {
      chunks.push(frame);
    }
  };
  const done = () => {
    socket.off(WIRE_EVENTS.chunk, onChunk);
    socket.off(WIRE_EVENTS.end, onEnd);
    socket.off(WIRE_EVENTS.fail, onFail);
    settle();
  };
  const onEnd = (frame: StreamEnd) => {
    if (frame.id === id) {
      state.end = frame;
      done();
    }
  };
  const onFail = (frame: StreamFail) => {
    if (frame.id === id) {
      state.fail = frame;
      done();
    }
  };

  // listening before the request goes out, so no frame can be missed
  socket.on(WIRE_EVENTS.chunk, onChunk);
  socket.on(WIRE_EVENTS.end, onEnd);
  socket.on(WIRE_EVENTS.fail, onFail);

  const request: CommandRequest = { id, name, payload, ...extra };
  if (credits !== undefined) {
    request.credits = credits;
  }

  return {
    id,
    reply: socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply>,
    chunks,
    get end() {
      return state.end;
    },
    get fail() {
      return state.fail;
    },
    finished,
    grant: (n: number) => {
      const frame: StreamCredit = { id, credits: n };
      socket.emit(WIRE_EVENTS.credit, frame);
    },
    cancel: () => {
      const frame: CancelFrame = { id };
      socket.emit(WIRE_EVENTS.cancel, frame);
    },
  };
}

/**
 * Consumes every chunk on arrival and grants credit with the client's rule ( http-socket-client ClientStream.replenish ):
 * keep granted - consumed <= window, grant in batches of at least max(1, floor(window / 2)).
 */
export function consumeAsClient(socket: ClientSocket, name: string, payload: unknown, window: number): IRawStream & { readonly overCredit: boolean } {
  const id = nextId();
  let granted = window;
  let consumed = 0;
  let overCredit = false;

  const s = rawStream(socket, name, payload, window, { id });
  const onChunk = (frame: Chunk) => {
    if (frame.id !== id) {
      return;
    }
    if (frame.seq >= granted) {
      overCredit = true;
    }
    consumed++;
    const free = window - (granted - consumed);
    if (free >= Math.max(1, Math.floor(window / 2))) {
      granted += free;
      s.grant(free);
    }
  };
  socket.on(WIRE_EVENTS.chunk, onChunk);
  void s.finished.then(() => socket.off(WIRE_EVENTS.chunk, onChunk));

  return Object.assign(Object.create(s) as IRawStream, {
    get overCredit() {
      return overCredit;
    },
  });
}
