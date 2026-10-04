import { DI } from '@spinajs/di';
import { IPerfMetric, Perf, PerfSink } from '@spinajs/log';
import { DefaultEmailService, EmailSender, IEmail } from '../src/index.js';

/** What `Perf` hands its sinks: a failed span carries the error, and the log sink prints it. */
const perfMetrics: IPerfMetric[] = [];

class RecordingPerfSink extends PerfSink {
  public collect(metric: IPerfMetric): void {
    perfMetrics.push(metric);
  }
}

DI.register(RecordingPerfSink).as(PerfSink);

/** Records what the transport was handed; `fail` makes it throw that error after recording. */
export class CapturingSender extends EmailSender {
  public readonly Captured: IEmail[] = [];
  public fail: ((email: IEmail) => Error) | null = null;

  constructor(public Options: any) {
    super();
  }

  public async send(email: IEmail): Promise<void> {
    this.Captured.push(email);
    if (this.fail) {
      throw this.fail(email);
    }
  }
}

/** Every argument of every log call, errors with their message, stack and own fields. */
export function recordingLog() {
  const calls: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push([level, ...args]);
  return { calls, log: { info: record('info'), warn: record('warn'), error: record('error'), trace: record('trace'), debug: record('debug'), success: record('success') } };
}

/**
 * A `DefaultEmailService` on one connection named `test`, without DI: `@Config` and `@Logger` install getter-only accessors on
 * the prototype, so the instance shadows them with `Object.defineProperty`.
 */
export function capturingEmailService() {
  const options = { name: 'test', service: 'CapturingSender' };
  const sender = new CapturingSender(options);
  const service = new DefaultEmailService();
  const { calls: logged, log } = recordingLog();
  const emitted: unknown[] = [];

  (service as any).Senders = new Map([['test', sender]]);
  (service as any).Queue = { emit: async (m: unknown) => void emitted.push(m) };
  Object.defineProperty(service, 'Log', { value: log, configurable: true });
  Object.defineProperty(service, 'IsProduction', { value: false, configurable: true });
  Object.defineProperty(service, 'Configuration', { value: { connections: [options], defaultConnection: 'test' }, configurable: true });

  perfMetrics.length = 0;
  Perf.refreshSinks();

  return { service, sender, logged, emitted, perf: perfMetrics };
}

/** Serialises anything a test inspects for a leaked secret, including errors and what hangs off them. */
export function dump(x: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(x, (_key, value) => {
    if (value instanceof Error) {
      if (seen.has(value)) return '[cycle]';
      seen.add(value);
      return { ...value, name: value.name, message: value.message, stack: value.stack, cause: (value as any).cause };
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[cycle]';
      seen.add(value);
    }
    return value;
  });
}

/** True when `text` holds `secret` raw or URI-encoded. */
export function holds(text: string, secret: string): boolean {
  return text.includes(secret) || text.includes(encodeURIComponent(secret));
}
