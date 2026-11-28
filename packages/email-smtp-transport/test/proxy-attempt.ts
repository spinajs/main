import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { inspect } from 'util';
import _ from 'lodash';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { EmailConnectionOptions } from '@spinajs/email';

import { EmailSenderSmtp } from '../src/index.js';

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { email: { templateFs: '' }, logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

export async function configure(): Promise<void> {
  DI.clearCache();
  DI.register(ConnectionConf).as(Configuration);
  await DI.resolve(Configuration);
}

class ProxySender extends EmailSenderSmtp {
  public get Proxy(): unknown {
    return _.get(this.Transporter?.options, 'proxy');
  }

  public close(): void {
    this.Transporter?.close();
  }
}

export interface LogCall {
  level: string;
  args: unknown[];
}

export interface Attempt {
  thrown: unknown;
  logs: LogCall[];
  /** The proxy option the nodemailer transporter holds, when one was created. */
  proxy: unknown;
  printed: string;
}

const show = (value: unknown): string => inspect(value, { depth: null, showHidden: true });

/** Resolves an SMTP sender for 127.0.0.1:2525 with these raw nodemailer options and records what it threw and logged. */
export async function attempt(raw: object): Promise<Attempt> {
  const options: Partial<EmailConnectionOptions> = { host: '127.0.0.1', port: 2525, options: raw };
  const sender = new ProxySender({ service: 'EmailSenderSmtp', name: 'orders-mail', resilience: { retries: 0, timeout: 3000 }, ...options });
  const logs: LogCall[] = [];
  const record = (level: string) => (...args: unknown[]) => void logs.push({ level, args });
  Object.defineProperty(sender, 'Log', { value: Object.fromEntries(['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal', 'security'].map((level) => [level, record(level)])) });
  const thrown = await sender.resolve().then(
    () => undefined,
    (error: unknown) => error,
  );
  sender.close();
  return { thrown, logs, proxy: sender.Proxy, printed: [show(thrown), ...logs.map((call) => show(call.args))].join('\n') };
}

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/proxy-child.ts', import.meta.url));

export interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one attempt with the raw option `key` set to `value` in a fresh process, which installs the tripwire and the socket guard first. */
export function runChild(key: 'proxy' | 'url', value: string): Promise<ChildRun> {
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
