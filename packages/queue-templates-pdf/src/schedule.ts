import { IMessageOptions } from '@spinajs/queue';
import { RenderPdfJob } from './RenderPdfJob.js';
import { IRenderOutput } from './protocol.js';

/** Payload for a {@link RenderPdfJob} - the fields describing what to render and where. */
export interface IRenderPdfJobPayload {
  /** Template path (template mode) or raw HTML string. */
  input: string;
  /** When true, `input` is a template rendered by extension; otherwise raw HTML. */
  template?: boolean;
  model?: unknown;
  lang?: string;
  /** Destination @spinajs/fs provider + path. */
  output: IRenderOutput;
  pdfOptions?: Record<string, unknown>;
  assetBasePath?: string;
  /** Optional inline worker config; omit to re-bootstrap the ambient app config. */
  config?: unknown;
  /** Max render duration before the worker is killed (ms). */
  timeoutMs?: number;
}

/** Scheduling options for {@link scheduleRenderPdf}. */
export interface IScheduleRenderPdfOptions {
  /** Delay before the job is delivered (ms). */
  delay?: number;
  /** Cron expression for recurring rendering (e.g. `0 6 * * *` for a daily report). */
  cron?: string;
  /** Period between repeats (ms), used with `repeat`. */
  period?: number;
  /** Number of times to repeat the schedule. */
  repeat?: number;
}

/**
 * Enqueue a PDF render job. With no options it runs as soon as a consumer picks
 * it up; `delay` schedules it later; `cron` (or `period` + `repeat`) makes it
 * recurring.
 *
 * Progress is tracked on the queue job model and exposed via
 * `@spinajs/queue-http-progress` at `GET jobs/v1/:jobId/status`
 * (percent + phase + message).
 *
 * @returns the JobId, for correlating the render with its progress/status endpoint.
 *
 * @example
 * // render now, then poll GET jobs/v1/:jobId/status
 * const jobId = await scheduleRenderPdf({ input: 'invoice.pug', template: true, model, output: { provider: 's3', path: 'invoices/1.pdf' } });
 * // daily at 6am
 * await scheduleRenderPdf({ input: 'report.pug', template: true, output: { provider: 'local', path: 'daily.pdf' } }, { cron: '0 6 * * *' });
 */
export async function scheduleRenderPdf(payload: IRenderPdfJobPayload, options?: IScheduleRenderPdfOptions): Promise<string | undefined> {
  // Only include schedule fields that are set. IMessageOptions declares all fields
  // required, but emit() spreads options into the message, so absent fields behave
  // exactly like calling emit with no options.
  const scheduleOptions: Partial<IMessageOptions> = {};
  if (options?.delay !== undefined) scheduleOptions.ScheduleDelay = options.delay;
  if (options?.cron !== undefined) scheduleOptions.ScheduleCron = options.cron;
  if (options?.period !== undefined) scheduleOptions.SchedulePeriod = options.period;
  if (options?.repeat !== undefined) scheduleOptions.ScheduleRepeat = options.repeat;

  return RenderPdfJob.emit(payload, scheduleOptions as IMessageOptions);
}
