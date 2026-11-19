import { AsyncService, Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

/** Outcome of a single health check. */
export type HealthStatus = 'up' | 'degraded' | 'down';

/** What a {@link HealthCheck} returns. */
export interface IHealthResult {
  status: HealthStatus;
  message?: string;
  data?: Record<string, unknown>;
}

/** One check's line in the readiness report. */
export interface IHealthCheckReport extends IHealthResult {
  name: string;
  /** How long the check took, in ms. */
  durationMs: number;
}

/** The body served by `GET /telemetry/ready`. */
export interface IReadyReport {
  status: HealthStatus;
  checks: IHealthCheckReport[];
}

/**
 * A readiness probe for one dependency.
 *
 * Register a concrete subclass with `@Injectable( HealthCheck )` and it is
 * discovered by {@link HealthCheckRunner} via `Array.ofType( HealthCheck )`.
 * `@spinajs/telemetry` deliberately ships NO concrete checks — a database check
 * belongs where the database dependency already is, not in the observability
 * package.
 *
 * `check()` may throw; a throw counts as `down`.
 */
export abstract class HealthCheck extends AsyncService {
  /** Stable identifier for this check, used as the report key. */
  public abstract Name: string;

  public abstract check(): Promise<IHealthResult>;
}

const RANK: Record<HealthStatus, number> = { up: 0, degraded: 1, down: 2 };

/**
 * Severity of one check's status, for the reduction in {@link HealthCheckRunner.run}.
 *
 * An unrecognised value ranks as `down`, not as harmless: `HealthStatus` is only
 * enforced at compile time, so a JS consumer ( or a check that forwards a status
 * from somewhere else ) can return `'DOWN'` or `'UNHEALTHY'`. A plain
 * `RANK[status] > RANK[worst]` reads `undefined` for those, and `undefined > n`
 * is false, so a genuinely failing dependency would leave the overall status at
 * `up` and `/telemetry/ready` would answer 200.
 */
function rank(status: HealthStatus): number {
  return RANK[status] ?? RANK.down;
}

/** The report line's `message` for a check that threw; the thrown error goes to the log. */
export const THREW_MESSAGE = 'the check threw';

/**
 * The report without each check's `data.error`, for a caller that may not read the probe detail
 * (`telemetry.auth.policies.probeDetail`).
 */
export function withoutErrorDetail(report: IReadyReport): IReadyReport {
  return {
    ...report,
    checks: report.checks.map((check) => {
      if (!check.data || !('error' in check.data)) return check;
      const { error: _error, ...data } = check.data;
      return { ...check, data };
    }),
  };
}

/**
 * Runs every registered {@link HealthCheck} concurrently, each raced against a
 * per-check timeout, and reduces the results to one overall status.
 *
 * The timeout is the point of the class: a readiness endpoint that can hang is
 * worse than no readiness endpoint, because a kubelet probe blocks on it.
 */
@Singleton()
@Injectable()
export class HealthCheckRunner {
  @Autoinject(HealthCheck)
  protected Checks!: HealthCheck[];

  @Config('telemetry.health.timeoutMs', { defaultValue: 2000 })
  protected TimeoutMs!: number;

  @Config('telemetry.health.failOnDegraded', { defaultValue: false })
  protected FailOnDegraded!: boolean;

  @Logger('telemetry')
  protected Log!: Log;

  /**
   * True when the overall status should be served as HTTP 503.
   */
  public isFailing(status: HealthStatus): boolean {
    if (status === 'down') return true;
    return status === 'degraded' && this.FailOnDegraded === true;
  }

  public async run(): Promise<IReadyReport> {
    const checks = await Promise.all((this.Checks ?? []).map((c) => this.runOne(c)));

    let worst: HealthStatus = 'up';
    for (const c of checks) {
      // The unrecognised status is reduced AS `down`, but the check's own line in
      // the report keeps the string the check actually returned — that value is
      // the only clue an operator has that a check is misbehaving, and rewriting
      // it would hide the misconfiguration behind a correct-looking report.
      if (rank(c.status) > rank(worst)) worst = RANK[c.status] !== undefined ? c.status : 'down';
    }

    return { status: worst, checks };
  }

  private async runOne(check: HealthCheck): Promise<IHealthCheckReport> {
    const startedAt = Date.now();
    const timeoutMs = this.TimeoutMs ?? 2000;
    const timedOut = new Error(`health check timed out after ${timeoutMs}ms`);

    let timer: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        check.check(),
        new Promise<IHealthResult>((_, reject) => {
          timer = setTimeout(() => reject(timedOut), timeoutMs);
        }),
      ]);

      return { name: check.Name, status: result.status, message: result.message, data: result.data, durationMs: Date.now() - startedAt };
    } catch (err) {
      if (err === timedOut) return { name: check.Name, status: 'down', message: timedOut.message, durationMs: Date.now() - startedAt };

      // A thrown message is driver or library text ( paths, hosts, SQL ) and the report is served to anonymous probes.
      this.Log.warn(err instanceof Error ? err : new Error(String(err)), 'health check %s threw', check.Name);
      return { name: check.Name, status: 'down', message: THREW_MESSAGE, durationMs: Date.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
