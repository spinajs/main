import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'crypto';

import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';

import { FakeSmtpServer } from './fake-smtp-server.js';
import { DnsTripwire, secretRuns, SocketGuard } from './network-guards.js';
import { attempt, configure, runChild } from './proxy-attempt.js';

const random = (prefix: string, bytes: number): string => `${prefix}${randomBytes(bytes).toString('hex')}`;
const USER = random('u', 6);
const HEAD = random('p', 5);
const TAIL = random('q', 5);
const PROXY = 'proxy.example.invalid';
const SECRETS = [USER, HEAD, TAIL, `${HEAD}\\${TAIL}`, `${HEAD}/${TAIL}`];

const URL_REFUSAL =
  "Email smtp connection orders-mail has an options.url that is not a URL: percent-encode a '/', '?', '#', '@' or '\\' in its user name, password or query (%2F, %3F, %23, %40, %5C), or set user / password";
const PROXY_REFUSAL =
  "Email smtp connection orders-mail has an options.proxy (or a proxy in options.url) that is not a URL: percent-encode a '/', '?', '#', '@' or '\\' in its user name, password or query (%2F, %3F, %23, %40, %5C)";

// url.parse() reads a backslash before the last '@' as '/', so the user name becomes the host; new URL() keeps it in the userinfo of an smtp:, socks: or registered scheme
const backslashUrl = (port: number): string => `smtp://${USER}:${HEAD}\\${TAIL}@127.0.0.1:${port}`;
const backslashProxy = `socks5://${USER}:${HEAD}\\${TAIL}@${PROXY}:1080`;
// nodemailer's SMTP transport parses a url in the query of options.url again, with url.parse()
const nestedMisread = (port: number): string => `smtp://127.0.0.1:2525/?url=${encodeURIComponent(`smtp://${USER}:${HEAD}/${TAIL}@127.0.0.1:${port}`)}`;

const plainAuth = (password: string): string => `AUTH PLAIN ${Buffer.from(`\u0000${USER}\u0000${password}`).toString('base64')}`;

describe('smtp transport - a backslash before the last @ and a url in the query of options.url are refused before any lookup or connection', function () {
  this.timeout(30000);
  const tripwire = new DnsTripwire();
  const guard = new SocketGuard();
  const server = new FakeSmtpServer();

  before(async () => {
    tripwire.install();
    guard.install();
    await server.listen('127.0.0.1');
    guard.AllowedPorts.add(server.Port);
    await configure();
  });

  after(async () => {
    await server.close();
    guard.restore();
    tripwire.restore();
  });

  beforeEach(() => {
    tripwire.Asked = [];
    guard.Dialled = [];
    server.Sessions = [];
  });

  it('listens the fake SMTP server on loopback only', () => {
    expect(server.Address).to.eq('127.0.0.1');
  });

  const refused: Array<[form: string, raw: () => object, message: string]> = [
    ['an options.url with a \\ in the password', () => ({ url: backslashUrl(server.Port) }), URL_REFUSAL],
    ['an smtps options.url with a \\ in the password', () => ({ url: `smtps://${USER}:${HEAD}\\${TAIL}@127.0.0.1:${server.Port}` }), URL_REFUSAL],
    ['an options.url with a \\ in the user name', () => ({ url: `smtp://${USER}\\x:${HEAD}@127.0.0.1:${server.Port}` }), URL_REFUSAL],
    ['an options.url with an @ and then a \\ in the password', () => ({ url: `smtp://${USER}:${HEAD}@127.0.0.1:${server.Port}\\${TAIL}@mail.example.invalid:25` }), URL_REFUSAL],
    ['a url in the query of options.url with an unencoded / in the password', () => ({ url: nestedMisread(server.Port) }), URL_REFUSAL],
    ['a url in the query of options.url with a \\ in the password', () => ({ url: `smtp://127.0.0.1:2525/?url=${encodeURIComponent(backslashUrl(server.Port))}` }), URL_REFUSAL],
    ['a socks5 options.proxy with a \\ in the password', () => ({ proxy: backslashProxy }), PROXY_REFUSAL],
    ['an options.proxy of a registered scheme with a \\ in the password', () => ({ proxy: `myproxy://${USER}:${HEAD}\\${TAIL}@${PROXY}:1080` }), PROXY_REFUSAL],
    ['a proxy in the query of options.url with a \\ in the password', () => ({ url: `smtp://127.0.0.1:2525/?proxy=${encodeURIComponent(backslashProxy)}` }), PROXY_REFUSAL],
  ];

  for (const [form, raw, message] of refused) {
    it(`refuses ${form} with InvalidArgument`, async () => {
      const { thrown, logs, printed } = await attempt(raw());

      expect(tripwire.Asked).to.deep.eq([]);
      expect(guard.Dialled).to.deep.eq([]);
      expect(server.Sessions).to.deep.eq([]);
      expect(thrown).to.be.instanceOf(InvalidArgument);
      expect(thrown).to.have.property('message', message);
      expect(logs).to.deep.eq([]);
      expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
    });
  }

  it('logs in with a percent-encoded \\ in the password of options.url', async () => {
    const { thrown } = await attempt({ url: `smtp://${USER}:${encodeURIComponent(`${HEAD}\\${TAIL}`)}@127.0.0.1:${server.Port}` });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(server.Sessions.flat()).to.include(plainAuth(`${HEAD}\\${TAIL}`));
    expect(tripwire.Asked).to.deep.eq([]);
  });

  it('dials the url in the query of options.url, which nodemailer uses instead of the outer host', async () => {
    const nested = `smtp://${USER}:${encodeURIComponent(`${HEAD}/${TAIL}`)}@127.0.0.1:${server.Port}`;
    const { thrown } = await attempt({ url: `smtp://127.0.0.1:2525/?url=${encodeURIComponent(nested)}` });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(guard.Dialled).to.deep.eq([{ host: '127.0.0.1', port: server.Port }]);
    expect(server.Sessions.flat()).to.include(plainAuth(`${HEAD}/${TAIL}`));
  });

  it('leaves a misread proxy inside the url in the query of options.url, which nodemailer ignores', async () => {
    const misreadProxy = `http://${USER}:${HEAD}/${TAIL}@${PROXY}:3128`;
    const nested = `smtp://127.0.0.1:${server.Port}/?proxy=${encodeURIComponent(misreadProxy)}`;
    const { thrown } = await attempt({ url: `smtp://127.0.0.1:2525/?url=${encodeURIComponent(nested)}` });

    // no credentials, so the fake server accepts the connection and verify succeeds
    expect(thrown).to.eq(undefined);
    expect(guard.Dialled).to.deep.eq([{ host: '127.0.0.1', port: server.Port }]);
    expect(server.Sessions).to.have.length(1);
    expect(tripwire.Asked).to.deep.eq([]);
  });

  it('hands an http proxy with a \\ after the host to nodemailer, which dials the proxy', async () => {
    const proxy = `http://${PROXY}:3128\\x`;
    const { thrown, proxy: held } = await attempt({ proxy });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(held).to.eq(proxy);
    expect(guard.Dialled).to.deep.eq([{ host: PROXY, port: 3128 }]);
  });
});

describe('smtp transport - a refused backslash or nested url prints nothing to stderr', function () {
  this.timeout(120000);

  const children: Array<[form: string, key: 'proxy' | 'url', value: string]> = [
    ['an options.url with a \\ in the password', 'url', backslashUrl(2525)],
    ['a socks5 options.proxy with a \\ in the password', 'proxy', backslashProxy],
    ['a url in the query of options.url with an unencoded / in the password', 'url', nestedMisread(2525)],
  ];

  for (const [form, key, value] of children) {
    it(`emits no DEP0170 warning for ${form}, in a fresh process`, async () => {
      const { code, stdout, stderr } = await runChild(key, value);

      expect(code, stderr).to.eq(0);
      expect(stderr).to.not.include('DEP0170');
      const report: unknown = JSON.parse(stdout);
      expect(report).to.deep.include({ thrown: 'InvalidArgument', logs: 0, asked: [], dialled: [] });
      expect(report).to.have.property('warnings').that.does.not.include('DEP0170');
      expect(secretRuns(`${stdout}\n${stderr}`, SECRETS)).to.deep.eq([]);
    });
  }
});
