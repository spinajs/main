import 'reflect-metadata';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { JobModel } from '@spinajs/queue';
import { ProgressReporterFn } from './models/JobEntry.js';

const REPORTER_PARAM_META = Symbol('queue-http-progress:reporter-param-index');

/**
 * Marks the parameter that will receive the ProgressReporterFn callback.
 * @WithProgress injects the actual reporter at this position automatically.
 *
 * Usage:
 *   public async myMethod(
 *     @Form() form: MyDTO,
 *     @ProgressReporter() progress: ProgressReporterFn,
 *   )
 */
export function ProgressReporter() {
  return (target: object, propertyKey: string | symbol, parameterIndex: number) => {
    Reflect.defineMetadata(REPORTER_PARAM_META, parameterIndex, target, propertyKey);
  };
}

/**
 * Wraps an HTTP endpoint method for async background execution with DB-tracked progress.
 *
 * Flow:
 *   1. HTTP request arrives — framework resolves all @Param / @Form / @XlsxFile parameters.
 *   2. @WithProgress creates a JobModel row (status: 'created').
 *   3. Injects a ProgressReporterFn at the @ProgressReporter()-marked parameter position.
 *   4. Fires the original method as a background void task (fire-and-forget).
 *   5. Returns { jobId } immediately — HTTP response is sent while work runs in background.
 *   6. Background task updates JobModel.Progress / Status on each progress() call.
 *   7. On finish: Status → 'success'. On error: Status → 'error', Result.error set.
 *
 * Poll status: GET /jobs/v1/:jobId/status
 *
 * The method signature stays natural — all existing parameter decorators work unchanged.
 * Only add @ProgressReporter() to the parameter that should receive the callback.
 */
export interface WithProgressOptions {
  /**
   * Queue connection name stored in JobModel.Connection.
   * Defaults to the value of `queue.default` from configuration, or 'default' as last resort.
   */
  connection?: string;
}

export function WithProgress(options?: WithProgressOptions) {
  return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const original: (...args: any[]) => Promise<any> = descriptor.value;

    descriptor.value = async function (this: any, ...resolvedArgs: any[]) {
      const jobId = crypto.randomUUID();
      const jobName = `${this.constructor.name}.${String(propertyKey)}`.substring(0, 100);

      // Resolve connection name: option > queue.default config > 'default'
      let connection: string = options?.connection ?? 'default';
      if (!options?.connection) {
        try {
          const cfg = DI.resolve(Configuration) as any;
          const cfgDefault: string | undefined = (cfg.get as (k: string) => string | undefined)('queue.default');
          if (cfgDefault) connection = cfgDefault;
        } catch {
          // config not ready — use fallback
        }
      }

      // Create the job row
      const jobRow = new JobModel<{ message?: string; error?: string }>();
      jobRow.JobId = jobId;
      jobRow.Name = jobName;
      jobRow.Status = 'created';
      jobRow.Progress = 0;
      jobRow.Connection = connection;
      await jobRow.insert();

      // Build progress reporter — updates DB on each call
      const progress: ProgressReporterFn = (percent: number, message?: string) => {
        void (async () => {
          const row = (await JobModel.select().where('JobId', jobId).first()) as
            | JobModel<{ message?: string; error?: string }>
            | undefined;
          if (!row || row.Status === 'success' || row.Status === 'error') return;
          row.Progress = Math.min(100, Math.max(0, percent));
          row.Status = 'executing';
          if (message !== undefined) row.Result = { ...(row.Result ?? {}), message };
          await row.update();
        })();
      };

      // Inject progress at the @ProgressReporter()-marked parameter index
      const reporterIndex: number | undefined = Reflect.getMetadata(
        REPORTER_PARAM_META,
        _target,
        propertyKey,
      );
      const args = [...resolvedArgs];
      if (reporterIndex !== undefined) {
        args[reporterIndex] = progress;
      }

      // Fire and forget
      void (async () => {
        try {
          await original.apply(this, args);
          const row = (await JobModel.select().where('JobId', jobId).first()) as
            | JobModel<{ message?: string; error?: string }>
            | undefined;
          if (row) {
            row.Progress = 100;
            row.Status = 'success';
            await row.update();
          }
        } catch (err: any) {
          const row = (await JobModel.select().where('JobId', jobId).first()) as
            | JobModel<{ message?: string; error?: string }>
            | undefined;
          if (row) {
            row.Status = 'error';
            row.Result = { ...(row.Result ?? {}), error: String(err?.message ?? err) };
            await row.update();
          }
        }
      })();

      return {
        async execute(_req: any, res: any) {
          res.status(202).json({ jobId });
        },
      };
    };

    return descriptor;
  };
}
