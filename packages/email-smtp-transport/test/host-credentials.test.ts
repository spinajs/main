import 'mocha';
import { expect } from 'chai';
import dns from 'dns';
import { createServer, isIP, Server, Socket } from 'net';
import { inspect } from 'util';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { EmailConnectionOptions } from '@spinajs/email';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';

import { EmailSenderSmtp } from '../src/index.js';

const USER = 'planted-user';
const PASSWORD = 'planted-secret';
const PLANTED = [PASSWORD, 'planted-token', Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString('base64'), Buffer.from(PASSWORD).toString('base64')];
const REFUSAL =
  'Email smtp connection orders-mail has a host that is not a host name: set host to the server name or IP address alone (no scheme, port or brackets; the port goes in port), and the user name and password in user / password';

const URL_REFUSAL =
  "Email smtp connection orders-mail has an options.url that is not a URL: percent-encode a '/', '?', '#' or '@' in its user name, password or query (%2F, %3F, %23, %40), or set user / password";

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { email: { templateFs: '' }, logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

const SETTINGS = new Set(['constructor', 'Resolver', 'setServers', 'getServers', 'setDefaultResultOrder', 'getDefaultResultOrder', 'cancel', 'setLocalAddress']);

/** Every resolver entry point records the name it is asked for and fails; the real resolver is never called. */
class DnsTripwire {
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
    const callback = args.findLast((arg): arg is (err: Error | null, address?: string, family?: number) => void => typeof arg === 'function');
    // net.Server.listen('::1') looks its literal up; the system resolver answers that without a query, so does this
    if (isIP(hostname) !== 0 && callback !== undefined) {
      process.nextTick(() => callback(null, hostname, isIP(hostname)));
      return undefined;
    }
    this.Asked.push(hostname);
    const error = Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
    if (callback === undefined) return Promise.reject(error);
    process.nextTick(() => callback(error));
    return undefined;
  }
}

/** Greets, answers EHLO with AUTH and refuses every login; keeps the lines each client sent. */
class FakeSmtpServer {
  public Sessions: string[][] = [];

  public Port = 0;

  private Server: Server = createServer((socket) => this.serve(socket));

  public async listen(host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.Server.once('error', reject);
      this.Server.listen(0, host, resolve);
    });
    const address = this.Server.address();
    this.Port = typeof address === 'object' && address !== null ? address.port : 0;
  }

  public close(): Promise<void> {
    return new Promise((resolve) => this.Server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    const lines: string[] = [];
    this.Sessions.push(lines);
    let pending = '';
    let login = 0;
    socket.on('error', () => undefined);
    socket.write('220 fake.invalid ESMTP\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        lines.push(line);
        socket.write(this.reply(line, login));
        login = /^AUTH LOGIN/i.test(line) || login === 1 ? login + 1 : 0;
        if (/^QUIT/i.test(line)) socket.end();
      }
    });
  }

  private reply(line: string, login: number): string {
    if (/^EHLO/i.test(line)) return '250-fake.invalid\r\n250 AUTH PLAIN LOGIN\r\n';
    if (/^AUTH LOGIN/i.test(line)) return '334 VXNlcm5hbWU6\r\n';
    if (login === 1) return '334 UGFzc3dvcmQ6\r\n';
    if (/^AUTH PLAIN/i.test(line) || login === 2) return '535 5.7.8 Authentication credentials invalid\r\n';
    if (/^QUIT/i.test(line)) return '221 bye\r\n';
    return '250 OK\r\n';
  }
}

class ClosableSender extends EmailSenderSmtp {
  public close(): void {
    this.Transporter?.close();
  }
}

interface LogCall {
  level: string;
  args: unknown[];
}

interface Attempt {
  thrown: unknown;
  logs: LogCall[];
  printed: string;
}

const show = (value: unknown): string => inspect(value, { depth: 8, showHidden: true });

async function attempt(options: Partial<EmailConnectionOptions>): Promise<Attempt> {
  const sender = new ClosableSender({ service: 'EmailSenderSmtp', name: 'orders-mail', resilience: { retries: 0, timeout: 3000 }, ...options });
  const logs: LogCall[] = [];
  const record = (level: string) => (...args: unknown[]) => void logs.push({ level, args });
  Object.defineProperty(sender, 'Log', { value: Object.fromEntries(['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal', 'security'].map((level) => [level, record(level)])) });
  const thrown = await sender.resolve().then(
    () => undefined,
    (error: unknown) => error,
  );
  sender.close();
  return { thrown, logs, printed: [show(thrown), ...logs.map((call) => show(call.args))].join('\n') };
}

const planted = (text: string): string[] => PLANTED.filter((value) => text.includes(value));

describe('smtp transport - a host that is not a host name is refused before any lookup', function () {
  this.timeout(30000);
  const tripwire = new DnsTripwire();
  const server = new FakeSmtpServer();

  before(async () => {
    tripwire.install();
    await server.listen('127.0.0.1');
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(async () => {
    tripwire.restore();
    await server.close();
  });

  beforeEach(() => {
    tripwire.Asked = [];
    server.Sessions = [];
  });

  const refused: Array<[form: string, options: () => Partial<EmailConnectionOptions>]> = [
    ['user:password@host', () => ({ host: `${USER}:${PASSWORD}@mail.example.invalid`, port: 587, user: USER, password: PASSWORD })],
    ['an smtp url', () => ({ host: `smtp://${USER}:${PASSWORD}@mail.example.invalid:587`, port: 587 })],
    ['an smtps url', () => ({ host: `smtps://${USER}:${PASSWORD}@mail.example.invalid`, ssl: true })],
    ['a host with a path and a query', () => ({ host: 'mail.example.invalid/planted-token?key=planted-token', port: 587 })],
    ['a host with a query', () => ({ host: 'mail.example.invalid?token=planted-token', port: 587 })],
    ['a host with a fragment', () => ({ host: 'mail.example.invalid#planted-token', port: 587 })],
    ['a host with a backslash', () => ({ host: 'mail.example.invalid\\planted-token', port: 587 })],
    ['a host with whitespace', () => ({ host: 'mail.example.invalid planted-token', port: 587 })],
    ['a host with a port', () => ({ host: 'mail.example.invalid:587', port: 587 })],
    ['a bracketed IPv6 literal', () => ({ host: '[::1]', port: 587 })],
    ['user:password@ an IPv4 literal of a live server', () => ({ host: `${USER}:${PASSWORD}@127.0.0.1`, port: server.Port })],
    ['user:password@host in options.host', () => ({ host: 'mail.example.invalid', port: 587, options: { host: `${USER}:${PASSWORD}@mail.example.invalid` } })],
  ];

  for (const [form, options] of refused) {
    it(`refuses ${form} with InvalidArgument before any lookup or connection`, async () => {
      const { thrown, logs, printed } = await attempt(options());

      expect(thrown).to.be.instanceOf(InvalidArgument);
      expect(thrown).to.have.property('message', REFUSAL);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(server.Sessions).to.deep.eq([]);
      expect(logs).to.deep.eq([]);
      expect(printed).to.not.include('planted');
    });
  }

  const asked: Array<[form: string, host: string]> = [
    ['a plain host name', 'mail.example.invalid'],
    ['a host name with a trailing dot', 'mail.example.invalid.'],
    ['an internationalised host name', 'bücher.example.invalid'],
    ['localhost', 'localhost'],
  ];

  for (const [form, host] of asked) {
    it(`looks ${form} up as written and fails verify with UnexpectedServerError`, async () => {
      const { thrown, logs } = await attempt({ host, port: 587, user: USER, password: PASSWORD });

      expect(thrown).to.be.instanceOf(UnexpectedServerError);
      expect(tripwire.Asked).to.include(host);
      expect(new Set(tripwire.Asked)).to.deep.eq(new Set([host]));
      expect(logs.map((call) => call.level)).to.deep.eq(['info', 'error']);
    });
  }

  it('dials an IPv4 literal and logs in with user / password', async () => {
    const { thrown, logs, printed } = await attempt({ host: '127.0.0.1', port: server.Port, user: USER, password: PASSWORD });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(thrown).to.have.property('message', `Cannot verify smtp connection orders-mail (smtp://127.0.0.1:${server.Port})`);
    expect(tripwire.Asked).to.deep.eq([]);
    expect(server.Sessions.flat()).to.include(`AUTH PLAIN ${Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString('base64')}`);
    expect(logs[0]).to.deep.eq({
      level: 'info',
      args: [{ user: USER, host: `smtp://127.0.0.1:${server.Port}`, secure: undefined }, 'Creating connection to smtp: ${user} at ${host}, secure: ${secure}'],
    });
    // this server's 535 does not quote the AUTH line, so no form of the credential may reach the error or a log line
    expect(planted(printed)).to.deep.eq([]);
  });

  it('dials an IPv6 literal', async function () {
    const server6 = new FakeSmtpServer();
    try {
      await server6.listen('::1');
    } catch {
      this.skip();
    }
    try {
      const { thrown } = await attempt({ host: '::1', port: server6.Port, user: USER, password: PASSWORD });

      expect(thrown).to.have.property('message', `Cannot verify smtp connection orders-mail (smtp://[::1]:${server6.Port})`);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(server6.Sessions.flat().some((line) => line.startsWith('AUTH PLAIN '))).to.eq(true);
    } finally {
      await server6.close();
    }
  });

  it('logs an internationalised host name as written', async () => {
    const { logs } = await attempt({ host: 'bücher.example.invalid', port: 587 });

    expect(logs[0].args[0]).to.have.property('host', 'smtp://bücher.example.invalid:587');
  });

  it('dials a pooled transport', async () => {
    const { thrown } = await attempt({ host: '127.0.0.1', port: server.Port, user: USER, password: PASSWORD, options: { pool: true } });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(server.Sessions.flat().some((line) => line.startsWith('AUTH PLAIN '))).to.eq(true);
  });

  // nodemailer reads options.url with the legacy url.parse(), which takes the user name for the host
  const brokenUrls: Array<[form: string, url: () => string]> = [
    ['an unencoded / in the password', () => `smtp://${USER}:planted/secret@127.0.0.1:${server.Port}`],
    ['an unencoded ? in the password', () => `smtp://${USER}:planted?secret@mail.example.invalid:587`],
    ['an unencoded # in the password', () => `smtps://${USER}:planted#secret@mail.example.invalid:465`],
    ['an unencoded / in the user name', () => `smtp://planted/user:${PASSWORD}@mail.example.invalid:587`],
    // dialled the right host before, but cannot be told apart from a password with an unencoded '/', '?' or '#'
    ['an unencoded @ in the query', () => `smtp://mail.example.invalid:587/?name=planted@example.invalid`],
  ];

  for (const [form, url] of brokenUrls) {
    it(`refuses an options.url with ${form} before any lookup`, async () => {
      const { thrown, logs, printed } = await attempt({ options: { url: url() } });

      expect(thrown).to.be.instanceOf(InvalidArgument);
      expect(thrown).to.have.property('message', URL_REFUSAL);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(server.Sessions).to.deep.eq([]);
      expect(logs).to.deep.eq([]);
      expect(printed).to.not.include('planted');
      expect(printed).to.not.include('secret');
    });
  }

  it('prints an options.url without its credentials', async () => {
    const { thrown, printed } = await attempt({ options: { url: `smtp://${USER}:${PASSWORD}@127.0.0.1:${server.Port}` } });

    expect(thrown).to.have.property('message', `Cannot verify smtp connection orders-mail (smtp://127.0.0.1:${server.Port})`);
    expect(server.Sessions.flat().some((line) => line.startsWith('AUTH PLAIN '))).to.eq(true);
    expect(planted(printed)).to.deep.eq([]);
  });
});
