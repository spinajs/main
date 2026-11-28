import 'mocha';
import { expect } from 'chai';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { createServer } from 'net';
import { fileURLToPath } from 'url';

import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';

import { DnsTripwire, Dial, secretRuns, SocketGuard } from './network-guards.js';
import { attempt, configure } from './proxy-attempt.js';

const random = (prefix: string, bytes: number): string => `${prefix}${randomBytes(bytes).toString('hex')}`;
const USER = random('u', 6);
const HEAD = random('p', 5);
const TAIL = random('q', 5);
const PROXY = 'proxy.example.invalid';

const PROXY_REFUSAL =
  "Email smtp connection orders-mail has an options.proxy (or a proxy in options.url) that is not a URL: percent-encode a '/', '?', '#' or '@' in its user name, password or query (%2F, %3F, %23, %40)";

/** The user name, the password and each of its halves, so no run of 8 characters of either may be printed. */
const SECRETS = [USER, HEAD, TAIL, `${HEAD}/${TAIL}`, `${HEAD}?${TAIL}`, `${HEAD}#${TAIL}`, `${HEAD}@${TAIL}`, `${HEAD}/@${TAIL}`];

// nodemailer reads options.proxy with the legacy url.parse(), which takes the user name of a broken-up userinfo for the proxy host
const misread: Array<[form: string, proxy: string]> = [
  ['http, an unencoded / in the password', `http://${USER}:${HEAD}/${TAIL}@${PROXY}:3128`],
  ['https, an unencoded ? in the password', `https://${USER}:${HEAD}?${TAIL}@${PROXY}:3128`],
  ['socks5, an unencoded # in the password', `socks5://${USER}:${HEAD}#${TAIL}@${PROXY}:1080`],
  ['socks4, an unencoded / in the user name', `socks4://${HEAD}/${TAIL}:${USER}@${PROXY}:1080`],
  // dialled the proxy before, but cannot be told apart from a password with an unencoded '/', '?' or '#'
  ['http, an unencoded @ in the query', `http://${PROXY}:3128/?via=${USER}@example.invalid`],
  ['https, an unencoded @ in the path', `https://${PROXY}:3128/${USER}@example.invalid`],
];

const encoded = encodeURIComponent(`${HEAD}/@${TAIL}`);

// with a url, nodemailer takes its proxy from the url's query and ignores options.proxy
const MISREAD_IN_URL = `smtp://127.0.0.1:2525/?proxy=${encodeURIComponent(misread[0][1])}`;

describe('smtp transport - an options.proxy that url.parse misreads is refused before any lookup or connection', function () {
  this.timeout(30000);
  const tripwire = new DnsTripwire();
  const guard = new SocketGuard();

  before(async () => {
    tripwire.install();
    guard.install();
    await configure();
  });

  after(() => {
    guard.restore();
    tripwire.restore();
  });

  beforeEach(() => {
    tripwire.Asked = [];
    guard.Dialled = [];
  });

  it('lets a fake server listen on the loopback address it asks for, under the tripwire', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    await new Promise((resolve) => server.close(resolve));

    expect(address).to.have.property('address', '127.0.0.1');
  });

  for (const [form, proxy] of misread) {
    it(`refuses ${form} with InvalidArgument`, async () => {
      const { thrown, logs, proxy: held, printed } = await attempt({ proxy });

      expect(guard.Dialled).to.deep.eq([]);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(thrown).to.be.instanceOf(InvalidArgument);
      expect(thrown).to.have.property('message', PROXY_REFUSAL);
      expect(logs).to.deep.eq([]);
      expect(held, 'no transporter was created').to.eq(undefined);
      expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
    });
  }

  it('refuses a misread proxy in the query of options.url with InvalidArgument', async () => {
    const { thrown, logs, printed } = await attempt({ url: MISREAD_IN_URL });

    expect(guard.Dialled).to.deep.eq([]);
    expect(tripwire.Asked).to.deep.eq([]);
    expect(thrown).to.be.instanceOf(InvalidArgument);
    expect(thrown).to.have.property('message', PROXY_REFUSAL);
    expect(logs).to.deep.eq([]);
    expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
  });

  it('leaves a misread options.proxy that nodemailer ignores beside options.url', async () => {
    const { thrown } = await attempt({ url: 'smtp://127.0.0.1:2525', proxy: misread[0][1] });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(guard.Dialled).to.deep.eq([{ host: '127.0.0.1', port: 2525 }]);
  });

  it('hands a well-formed proxy in the query of options.url to nodemailer, which dials the proxy', async () => {
    const proxy = `http://${USER}:${encoded}@${PROXY}:3128`;
    const { thrown, proxy: held, printed } = await attempt({ url: `smtp://127.0.0.1:2525/?proxy=${encodeURIComponent(proxy)}` });

    expect(thrown).to.be.instanceOf(UnexpectedServerError);
    expect(held).to.eq(proxy);
    expect(guard.Dialled).to.deep.eq([{ host: PROXY, port: 3128 }]);
    expect(tripwire.Asked).to.deep.eq([]);
    expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
  });

  const dialled: Array<[form: string, proxy: string, dial: Dial]> = [
    ['http, a percent-encoded / and @ in the password', `http://${USER}:${encoded}@${PROXY}:3128`, { host: PROXY, port: 3128 }],
    ['http, an unencoded @ in the password', `http://${USER}:${HEAD}@${TAIL}@${PROXY}:3128`, { host: PROXY, port: 3128 }],
    ['https, no credentials', `https://${PROXY}:3129`, { host: PROXY, port: 3129 }],
    ['http, a trailing / and a percent-encoded @ in the query', `http://${PROXY}:3128/?via=ops%40example.invalid`, { host: PROXY, port: 3128 }],
    ['HTTP, an IPv4 literal', `HTTP://${USER}:${encoded}@127.0.0.1:3128`, { host: '127.0.0.1', port: 3128 }],
    ['http, an IPv6 literal', `http://${USER}:${encoded}@[::1]:3128`, { host: '::1', port: 3128 }],
  ];

  for (const [form, proxy, dial] of dialled) {
    it(`hands ${form} to nodemailer unchanged, which dials the proxy`, async () => {
      const { thrown, proxy: held, printed } = await attempt({ proxy });

      expect(thrown).to.be.instanceOf(UnexpectedServerError);
      expect(held).to.eq(proxy);
      expect(guard.Dialled).to.deep.eq([dial]);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
    });
  }

  for (const scheme of ['socks', 'socks4', 'socks4a', 'socks5']) {
    it(`hands a ${scheme} proxy to nodemailer unchanged`, async () => {
      const proxy = `${scheme}://${USER}:${encoded}@${PROXY}:1080`;
      const { thrown, proxy: held, printed } = await attempt({ proxy });

      expect(thrown).to.be.instanceOf(UnexpectedServerError);
      expect(thrown).to.have.nested.property('cause.message', 'Socks module not loaded');
      expect(held).to.eq(proxy);
      expect(guard.Dialled).to.deep.eq([]);
      expect(tripwire.Asked).to.deep.eq([]);
      expect(secretRuns(printed, SECRETS)).to.deep.eq([]);
    });
  }

  const ignored: Array<[form: string, proxy: unknown]> = [
    ['an empty string', ''],
    ['a number', 3128],
    ['an object', { host: PROXY, port: 3128 }],
  ];

  for (const [form, proxy] of ignored) {
    it(`leaves ${form} to nodemailer, which ignores it and dials the server`, async () => {
      const { thrown } = await attempt({ proxy });

      expect(thrown).to.be.instanceOf(UnexpectedServerError);
      expect(guard.Dialled).to.deep.eq([{ host: '127.0.0.1', port: 2525 }]);
    });
  }
});

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/proxy-child.ts', import.meta.url));

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one attempt with the raw option `key` set to `value` in a fresh process, which installs the tripwire and the socket guard first. */
function runChild(key: 'proxy' | 'url', value: string): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-specifier-resolution=node', '--loader=ts-node/esm', CHILD, key, value], {
      cwd: PACKAGE,
      env: { ...process.env, NODE_OPTIONS: '', TS_NODE_PROJECT: 'tsconfig.json' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 100_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('smtp transport - a refused options.proxy prints nothing to stderr', function () {
  this.timeout(120000);

  const children: Array<[form: string, key: 'proxy' | 'url', value: string]> = [
    ...misread.slice(0, 3).map(([form, proxy]): [string, 'proxy', string] => [form, 'proxy', proxy]),
    ['a proxy in the query of options.url with an unencoded / in the password', 'url', MISREAD_IN_URL],
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
