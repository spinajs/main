import { AsyncService, Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

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
      if (RANK[c.status] > RANK[worst]) worst = c.status;
    }

    return { status: worst, checks };
  }

  private async runOne(check: HealthCheck): Promise<IHealthCheckReport> {
    const startedAt = Date.now();
    const timeoutMs = this.TimeoutMs ?? 2000;

    let timer: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        check.check(),
        new Promise<IHealthResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);

      return { name: check.Name, status: result.status, message: result.message, data: result.data, durationMs: Date.now() - startedAt };
    } catch (err) {
      return { name: check.Name, status: 'down', message: (err as Error)?.message ?? String(err), durationMs: Date.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
