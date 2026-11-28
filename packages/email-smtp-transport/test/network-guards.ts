import dns from 'dns';
import { isIP, Socket } from 'net';

const SETTINGS = new Set(['constructor', 'Resolver', 'setServers', 'getServers', 'setDefaultResultOrder', 'getDefaultResultOrder', 'cancel', 'setLocalAddress']);

/** Every resolver entry point records the name it is asked for and fails; the real resolver is never called. */
export class DnsTripwire {
  public Asked: string[] = [];

  private Saved: Array<[target: object, key: string, descriptor: PropertyDescriptor]> = [];

  public install(): void {
    for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
      for (const key of Object.getOwnPropertyNames(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (SETTINGS.has(key) || descriptor === undefined || typeof descriptor.value !== 'function') continue;
        this.Saved.push([target, key, descriptor]);
        Object.defineProperty(target, key, { configurable: true, writable: true, value: (...args: unknown[]) => this.fail(args) });
      }
    }
  }

  public restore(): void {
    for (const [target, key, descriptor] of this.Saved) Object.defineProperty(target, key, descriptor);
    this.Saved = [];
  }

  private fail(args: unknown[]): Promise<never> | undefined {
    const hostname = String(args[0]);
    const callback = args.findLast((arg): arg is (...result: unknown[]) => void => typeof arg === 'function');
    const family = isIP(hostname);
    // net.Server.listen('::1') looks its literal up; the system resolver answers that without a query, so does this
    if (family !== 0 && callback !== undefined) {
      // net.Server.listen() asks with { all: true } and expects an array; a single address makes it bind to every interface
      const all = typeof args[1] === 'object' && args[1] !== null && Reflect.get(args[1], 'all') === true;
      process.nextTick(() => (all ? callback(null, [{ address: hostname, family }]) : callback(null, hostname, family)));
      return undefined;
    }
    this.Asked.push(hostname);
    const error = Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
    if (callback === undefined) return Promise.reject(error);
    process.nextTick(() => callback(error));
    return undefined;
  }
}

export interface Dial {
  host: string;
  port: number;
}

/** Destroys every socket before it can look a name up or connect, except one to 127.0.0.1 at an allowed port, and records where each was meant to go. */
export class SocketGuard {
  public Dialled: Dial[] = [];

  /** Ports of fake servers the test itself opened on 127.0.0.1. */
  public AllowedPorts = new Set<number>();

  private Saved: PropertyDescriptor | undefined;

  public install(): void {
    const saved = Object.getOwnPropertyDescriptor(Socket.prototype, 'connect');
    this.Saved = saved;
    const connect: unknown = saved?.value;
    const admit = (dial: Dial): boolean => {
      this.Dialled.push(dial);
      return dial.host === '127.0.0.1' && this.AllowedPorts.has(dial.port);
    };
    Object.defineProperty(Socket.prototype, 'connect', {
      configurable: true,
      writable: true,
      value: function (this: Socket, ...args: unknown[]): Socket {
        if (admit(target(args)) && typeof connect === 'function') {
          Reflect.apply(connect, this, args);
          return this;
        }
        // the message names no host: the host may be a user name that nodemailer misread
        process.nextTick(() => this.destroy(Object.assign(new Error('connection refused by the socket guard'), { code: 'ECONNREFUSED' })));
        return this;
      },
    });
  }

  public restore(): void {
    if (this.Saved !== undefined) Object.defineProperty(Socket.prototype, 'connect', this.Saved);
    this.Saved = undefined;
  }
}

/** net.connect() hands Socket.connect() its normalized [options, listener] array; a direct call passes options or (port, host). */
function target(args: unknown[]): Dial {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const host: unknown = Reflect.get(first, 'host');
    return { host: typeof host === 'string' ? host : 'localhost', port: Number(Reflect.get(first, 'port')) };
  }
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
}

/** Every run of `length` characters of each secret that occurs in the text. */
export function secretRuns(text: string, secrets: string[], length = 8): string[] {
  const runs = secrets.flatMap((secret) => Array.from({ length: Math.max(secret.length - length + 1, 0) }, (_, start) => secret.slice(start, start + length)));
  return runs.filter((run) => text.includes(run));
}
