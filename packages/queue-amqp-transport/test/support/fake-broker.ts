import { createServer, Server, Socket } from 'net';

/**
 * What the fake broker does with one accepted connection:
 * - `open` completes the AMQP 0-9-1 handshake with a 1 s heartbeat, opens channels, then never sends a heartbeat;
 * - `close-at-once` destroys the socket as soon as it is accepted;
 * - `refuse-login` answers the client's credentials with 403 ACCESS_REFUSED, as RabbitMQ does;
 * - `no-vhost` answers connection.open with 530 NOT_ALLOWED, as RabbitMQ does for a missing vhost;
 * - `silent` accepts and never answers.
 */
export type BrokerScript = 'open' | 'close-at-once' | 'refuse-login' | 'no-vhost' | 'silent';

export interface FakeBroker {
  port: number;
  close(): Promise<void>;
}

const FRAME_METHOD = 1;
const FRAME_END = 0xce;
const PROTOCOL_HEADER_LENGTH = 8;

const shortstr = (text: string): Buffer => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);
const longstr = (text: string): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Buffer.byteLength(text));
  return Buffer.concat([length, Buffer.from(text)]);
};
const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

function method(channel: number, classId: number, methodId: number, args: Buffer[] = []): Buffer {
  const payload = Buffer.concat([u16(classId), u16(methodId), ...args]);
  return Buffer.concat([Buffer.from([FRAME_METHOD]), u16(channel), u32(payload.length), payload, Buffer.from([FRAME_END])]);
}

const connectionStart = (): Buffer => method(0, 10, 10, [Buffer.from([0, 9]), u32(0), longstr('PLAIN'), longstr('en_US')]);
const connectionClose = (code: number, text: string, classId: number, methodId: number): Buffer => method(0, 10, 50, [u16(code), shortstr(text), u16(classId), u16(methodId)]);

/** The reply the `open` script gives to a client method, or undefined for one it ignores. */
function openReply(channel: number, classId: number, methodId: number): Buffer | undefined {
  const replies: Record<string, Buffer> = {
    '10.11': method(0, 10, 30, [u16(0), u32(131072), u16(1)]),
    '10.40': method(0, 10, 41, [shortstr('')]),
    '10.50': method(0, 10, 51),
    '20.10': method(channel, 20, 11, [longstr('')]),
    '20.40': method(channel, 20, 41),
    '60.10': method(channel, 60, 11),
    '85.10': method(channel, 85, 11),
  };
  return replies[`${classId}.${methodId}`];
}

function reply(script: BrokerScript, socket: Socket, channel: number, classId: number, methodId: number): void {
  if (script === 'refuse-login' && classId === 10 && methodId === 11) {
    socket.end(connectionClose(403, 'ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN. For details see the broker logfile.', 0, 0));
    return;
  }
  if (script === 'no-vhost' && classId === 10 && methodId === 40) {
    socket.end(connectionClose(530, 'NOT_ALLOWED - vhost vhost not found', 10, 40));
    return;
  }
  const answer = openReply(channel, classId, methodId);
  if (answer !== undefined) socket.write(answer);
}

function serve(script: BrokerScript, socket: Socket): void {
  socket.on('error', () => {
    // the client tears its socket down after every failure
  });
  if (script === 'close-at-once') {
    socket.destroy();
    return;
  }
  if (script === 'silent') return;

  let pending = Buffer.alloc(0);
  let greeted = false;
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!greeted && pending.length >= PROTOCOL_HEADER_LENGTH) {
      greeted = true;
      pending = pending.subarray(PROTOCOL_HEADER_LENGTH);
      socket.write(connectionStart());
    }
    while (greeted && pending.length >= 7 && pending.length >= 8 + pending.readUInt32BE(3)) {
      const size = pending.readUInt32BE(3);
      if (pending[0] === FRAME_METHOD) reply(script, socket, pending.readUInt16BE(1), pending.readUInt16BE(7), pending.readUInt16BE(9));
      pending = pending.subarray(8 + size);
    }
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening on TCP');
  return address.port;
}

/** A local AMQP 0-9-1 broker stand-in on 127.0.0.1; connection n follows `scripts[n]`, later ones the last script. */
export async function fakeBroker(scripts: BrokerScript[]): Promise<FakeBroker> {
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(scripts[Math.min(accepted++, scripts.length - 1)], socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: portOf(server),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port on 127.0.0.1 that nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
