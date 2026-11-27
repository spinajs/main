import { createServer } from 'net';
import type { AddressInfo, Server, Socket } from 'net';

/** A RESP reply, or one written just before the server drops the connection. */
export type Reply = string | { close: string };

/** Answers one command; undefined falls back to the handshake defaults. */
export type Rule = (name: string, args: string[]) => Reply | undefined;

export const ok = '+OK\r\n';
export const nil = '$-1\r\n';
export const error = (text: string) => `-${text}\r\n`;
export const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
export const array = (items: string[]) => `*${items.length}\r\n${items.join('')}`;

/** Splits complete RESP command arrays off the front of `buffer`. */
function commandsIn(buffer: Buffer): [string[][], Buffer] {
  const commands: string[][] = [];
  let at = 0;
  for (;;) {
    const parsed = commandAt(buffer, at);
    if (!parsed) {
      return [commands, buffer.subarray(at)];
    }
    commands.push(parsed[0]);
    at = parsed[1];
  }
}

function commandAt(buffer: Buffer, start: number): [string[], number] | undefined {
  const lineAt = (from: number): [string, number] | undefined => {
    const end = buffer.indexOf('\r\n', from);
    return end < 0 ? undefined : [buffer.toString('utf8', from, end), end + 2];
  };
  const head = lineAt(start);
  if (!head) {
    return undefined;
  }
  const count = Number(head[0].slice(1));
  const parts: string[] = [];
  let at = head[1];
  for (let i = 0; i < count; i++) {
    const length = lineAt(at);
    if (!length) {
      return undefined;
    }
    const size = Number(length[0].slice(1));
    if (buffer.length < length[1] + size + 2) {
      return undefined;
    }
    parts.push(buffer.toString('utf8', length[1], length[1] + size));
    at = length[1] + size + 2;
  }
  return [parts, at];
}

/** INFO answers ioredis's ready check; CLIENT SETINFO, SELECT, QUIT and the rest get +OK. */
const handshake = (name: string) => (name === 'info' ? bulk('# Server\r\nloading:0\r\n') : ok);

/**
 * A Redis stand-in on 127.0.0.1 that stores nothing: `rule` decides each reply,
 * so real ioredis builds its errors exactly as it would against a server.
 */
export class FakeRedis {
  public rule: Rule = () => undefined;

  public readonly seen: string[][] = [];

  private server: Server | undefined;

  private readonly sockets = new Set<Socket>();

  public get port(): number {
    return (this.server!.address() as AddressInfo).port;
  }

  public async open(): Promise<void> {
    this.server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  public async close(): Promise<void> {
    this.sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const [commands, rest] = commandsIn(Buffer.concat([pending, chunk]));
      pending = rest;
      let out = '';
      for (const [name, ...args] of commands) {
        const lower = name.toLowerCase();
        this.seen.push([lower, ...args]);
        const reply = this.rule(lower, args) ?? handshake(lower);
        if (typeof reply !== 'string') {
          socket.end(out + reply.close, () => socket.destroy());
          return;
        }
        out += reply;
      }
      socket.write(out);
    });
  }
}
