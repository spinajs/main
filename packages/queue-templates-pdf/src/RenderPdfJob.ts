import { fork, ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NewInstance } from '@spinajs/di';
import { QueueJob, Job, JobProgressCallback } from '@spinajs/queue';
import { Log, Logger } from '@spinajs/log';
import { IRenderRequest, IRenderOutput, WorkerMessage } from './protocol.js';

/** Default max render duration before the worker is force-killed (ms). */
const DEFAULT_RENDER_TIMEOUT_MS = 120000;

/** Time the worker gets to clean up after SIGTERM before it is SIGKILLed (ms). */
const KILL_GRACE_MS = 5000;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Queue job that renders a PDF in an isolated worker process and reports render
 * progress (percent + phase + message) back to the queue. All heavy/crash-prone
 * work (Chromium, template compile, fs upload) runs in the forked worker; this
 * class only supervises it.
 */
@NewInstance()
@Job()
export class RenderPdfJob extends QueueJob {
  @Logger('RenderPdfJob')
  protected Log: Log;

  /** Template path (template mode) or raw HTML string. */
  public input: string;
  /** When true, `input` is a template rendered by extension; otherwise raw HTML. */
  public template?: boolean;
  public model?: unknown;
  public lang?: string;
  /** Destination @spinajs/fs provider + path. */
  public output: IRenderOutput;
  public pdfOptions?: Record<string, unknown>;
  public assetBasePath?: string;
  /** Optional inline worker config; omit to re-bootstrap the ambient app config. */
  public config?: unknown;
  /** Max render duration before the worker is killed (ms). */
  public timeoutMs?: number;

  public async execute(progress: JobProgressCallback): Promise<unknown> {
    const child = this.spawnWorker();
    return this.superviseChild(child, progress);
  }

  /** Spawn the render worker process. Overridable in tests. */
  protected spawnWorker(): ChildProcess {
    return fork(join(MODULE_DIR, 'render-worker.js'), process.argv.slice(2));
  }

  protected buildRequest(): IRenderRequest {
    return {
      input: this.input,
      template: this.template,
      model: this.model,
      lang: this.lang,
      output: this.output,
      pdfOptions: this.pdfOptions,
      assetBasePath: this.assetBasePath,
      config: this.config,
    };
  }

  /**
   * Drive one worker to completion: relay progress to the queue, resolve on
   * `done`, reject on `error` / unexpected exit, and terminate the worker on timeout.
   * Every terminal path clears the timer and detaches listeners exactly once.
   */
  protected superviseChild(child: ChildProcess, progress: JobProgressCallback): Promise<IRenderOutput> {
    const timeoutMs = this.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

    return new Promise<IRenderOutput>((resolve, reject) => {
      let settled = false;

      const settle = (action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners('message');
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
        action();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`Render worker timed out after ${timeoutMs}ms`)));
        // SIGTERM first so the worker can remove its temp PDF; SIGKILL if it does not exit
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS).unref();
      }, timeoutMs);

      child.on('message', (m: WorkerMessage) => {
        switch (m.type) {
          case 'progress':
            // fire-and-forget: never block the worker on progress persistence
            progress(m.percent, { phase: m.phase, message: m.message }).catch((err) => this.Log?.warn(`Failed to persist progress: ${err.message}`));
            break;
          case 'done':
            settle(() => resolve(m.result));
            break;
          case 'error':
            settle(() => reject(new Error(m.message)));
            child.kill();
            break;
        }
      });

      child.on('error', (err) => settle(() => reject(err)));
      child.on('exit', (code) => settle(() => reject(new Error(`Render worker exited unexpectedly with code ${code}`))));

      child.send(this.buildRequest());
    });
  }
}
