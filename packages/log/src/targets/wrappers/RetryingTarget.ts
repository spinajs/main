import { ICommonTargetOptions, ILogEntry, ITargetsOption, LogTarget } from "@spinajs/log-common";
import { DI, Injectable, Singleton } from "@spinajs/di";
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder, TimeSpan } from "@spinajs/util";

/**
 * Options for {@link RetryingTarget}.
 */
export interface IRetryingTargetOptions extends ICommonTargetOptions {
  options: {
    /**
     * Inline child target this wrapper decorates. Resolved through DI exactly
     * like a top-level target.
     */
    target: ITargetsOption;

    /**
     * Total number of write attempts ( the first try plus retries ). Default 3.
     */
    maxAttempts?: number;

    /**
     * Base delay in milliseconds between retries ( exponential backoff + jitter
     * is applied on top ). Default 100.
     */
    delayMs?: number;
  };
}

/**
 * Wraps ONE inner target and RETRIES its `write` when it REJECTS, using the
 * `@spinajs/util` resilience pipeline ( exponential backoff + jitter ). Only
 * useful for targets that surface failure by rejecting ( console / custom /
 * strict ) — self-healing targets ( File / Loki / OTLP ) own their reliability
 * and resolve, so wrapping them is a no-op. See the write() rejection contract
 * on {@link LogTarget.write}.
 *
 * The inner target is declared inline and owned by this wrapper ( resolve /
 * flush / dispose ). Pure / browser-safe - just delegates to its child.
 */
@Singleton()
@Injectable("RetryingTarget")
export class RetryingTarget extends LogTarget<IRetryingTargetOptions> {
  protected Inner: LogTarget<ICommonTargetOptions>;

  /** Reusable retry pipeline guarding the inner write. */
  protected RetryPipeline: ResiliencePipeline<void>;

  public resolve(): void {
    this.Inner = DI.resolve<LogTarget<ICommonTargetOptions>>(this.Options.options.target.type, [this.Options.options.target]);

    const maxAttempts = this.Options.options.maxAttempts ?? 3;
    const delayMs = this.Options.options.delayMs ?? 100;

    // MaxRetryAttempts counts RETRIES ( on top of the first attempt ), so
    // subtract one from the total attempt budget.
    this.RetryPipeline = new ResiliencePipelineBuilder<void>()
      .addRetry({
        MaxRetryAttempts: Math.max(0, maxAttempts - 1),
        Delay: TimeSpan.fromMilliseconds(delayMs),
        BackoffType: BackoffType.Exponential,
        UseJitter: true,
      })
      .build();

    super.resolve();
  }

  public write(entry: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return Promise.resolve();
    }

    // wrap in Promise.resolve because some targets' write is sync / void. The
    // pipeline retries whenever the inner write REJECTS.
    return this.RetryPipeline.execute(() => Promise.resolve(this.Inner.write(entry)).then(() => undefined));
  }

  public forceFlush(): Promise<void> {
    return this.Inner.forceFlush();
  }

  public async dispose(): Promise<void> {
    await (this.Inner as any).dispose?.();
  }
}
