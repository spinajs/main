import { ICommonTargetOptions, ILogEntry, ITargetsOption, LogTarget } from "@spinajs/log-common";
import { DI, Injectable, Singleton } from "@spinajs/di";

/**
 * Options for {@link SplitGroupTarget}.
 */
export interface ISplitGroupTargetOptions extends ICommonTargetOptions {
  options: {
    /**
     * Inline child target definitions this group fans out to. Each is resolved
     * through DI exactly like a top-level target, so any registered target type
     * ( File, Json, Loki, another wrapper ... ) can be nested here.
     */
    targets: ITargetsOption[];
  };
}

/**
 * Fan-out wrapper: one configured target name that writes every entry to MANY
 * inner targets. The inner targets are declared inline under `options.targets`
 * and are owned by this wrapper ( they are NOT part of the logger's Targets
 * list ), so the wrapper resolves, flushes and disposes them.
 *
 * Pure / browser-safe - just delegates to its children.
 */
@Singleton()
@Injectable("SplitGroupTarget")
export class SplitGroupTarget extends LogTarget<ISplitGroupTargetOptions> {
  protected Inner: LogTarget<ICommonTargetOptions>[] = [];

  public resolve(): void {
    // resolve each child via DI exactly like FrameworkLogger.resolveLogTargets
    // does - the child's ITargetsOption is passed as the single ctor arg.
    this.Inner = this.Options.options.targets.map((t) => DI.resolve<LogTarget<ICommonTargetOptions>>(t.type, [t]));

    super.resolve();
  }

  public write(entry: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return Promise.resolve();
    }

    // wrap in Promise.resolve because some targets' write is sync / void.
    return Promise.allSettled(this.Inner.map((t) => Promise.resolve(t.write(entry)))).then(() => undefined);
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
