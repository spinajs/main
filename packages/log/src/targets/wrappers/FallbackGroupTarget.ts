import { ICommonTargetOptions, ILogEntry, ITargetsOption, Logger, Log, LogTarget } from "@spinajs/log-common";
import { DI, Injectable, Singleton } from "@spinajs/di";

/**
 * Options for {@link FallbackGroupTarget}.
 */
export interface IFallbackGroupTargetOptions extends ICommonTargetOptions {
  options: {
    /**
     * ORDERED inline child target definitions: the PRIMARY first, then one or
     * more fallbacks. Each is resolved through DI exactly like a top-level
     * target, so any registered target type ( File, Loki, another wrapper ... )
     * can be nested here.
     */
    targets: ITargetsOption[];
  };
}

/**
 * Failover wrapper: an ORDERED list of targets ( primary first, fallbacks
 * after ). It handles TWO complementary failure modes so a durable fallback
 * catches exactly what a down primary never delivered — with no duplicates:
 *
 *  - **A ( immediate write rejection ).** `write()` tries the primary; if it
 *    REJECTS ( see the contract on {@link LogTarget.write} ) it advances to the
 *    next target, and so on, resolving on the first success. If every target
 *    rejects the last rejection is swallowed ( warn-only ) so logging never
 *    throws into the caller.
 *
 *  - **D ( later async drop ).** Self-healing network targets ( Loki / OTLP )
 *    RESOLVE `write()` immediately and only later GIVE UP on an entry ( buffer
 *    overflow or a non-retryable delivery failure ). resolve() wires each
 *    target's {@link LogTarget.OnDropped} hook to the NEXT target's write, so
 *    those late drops spill down the chain to the fallback. The last target has
 *    no successor, so its OnDropped stays null.
 *
 * The inner targets are declared inline and owned by this wrapper ( resolve /
 * flush / dispose ). Pure / browser-safe - just delegates to its children.
 */
@Singleton()
@Injectable("FallbackGroupTarget")
export class FallbackGroupTarget extends LogTarget<IFallbackGroupTargetOptions> {
  @Logger("FallbackGroupTarget")
  protected Log: Log;

  protected Inner: LogTarget<ICommonTargetOptions>[] = [];

  public resolve(): void {
    // resolve each child via DI exactly like FrameworkLogger.resolveLogTargets
    // does - the child's ITargetsOption is passed as the single ctor arg.
    this.Inner = this.Options.options.targets.map((t) => DI.resolve<LogTarget<ICommonTargetOptions>>(t.type, [t]));

    // mechanism D: wire the drop-hook chain. For each consecutive pair, entries
    // target[i] GIVES UP on flow to target[i+1].write. The last target has no
    // fallback -> its OnDropped stays null.
    for (let i = 0; i < this.Inner.length - 1; i++) {
      const next = this.Inner[i + 1];
      this.Inner[i].OnDropped = (entry: ILogEntry) => {
        void Promise.resolve(next.write(entry)).catch(() => {
          /* fallback itself gave up - nothing more to do */
        });
      };
    }

    super.resolve();
  }

  public async write(entry: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    // mechanism A: try each target in order; resolve on the first success. Only
    // advance to the next when the current one REJECTS.
    for (const t of this.Inner) {
      try {
        await Promise.resolve(t.write(entry));
        return;
      } catch {
        /* rejected -> try the next fallback */
      }
    }

    // every target rejected - swallow ( warn-only ) so logging never throws.
    this.Log?.warn(`FallbackGroupTarget ${this.Options.name}: all ${this.Inner.length} targets rejected the entry.`);
  }

  public forceFlush(): Promise<void> {
    return Promise.allSettled(this.Inner.map((t) => t.forceFlush())).then(() => undefined);
  }

  public async dispose(): Promise<void> {
    // the wrapper owns its children ( they are not in the logger's Targets list )
    // so it drives their teardown.
    await Promise.allSettled(this.Inner.map((t) => (t as any).dispose?.()));
  }
}
