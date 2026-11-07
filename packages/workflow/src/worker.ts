import { Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Clock, type TimerHandle } from '@spinajs/durable';
import { Log, Logger } from '@spinajs/log-common';
import { WorkflowEngine } from './engine.js';
import { isCrash } from './errors.js';
import { resolveWorkflowConfig, type WorkflowConfig } from './workflow-config.js';

/** The workflow runtime's only timer: one engine tick per `workflow.tick`, never two at once. Resolve it at boot. */
@Singleton()
@Injectable()
export class WorkflowWorker extends AsyncService {
  @Logger('WORKFLOW')
  protected Log: Log;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Config('workflow', { defaultValue: {} })
  protected RawConfig: Partial<WorkflowConfig>;

  public Engine: WorkflowEngine;
  protected handle?: TimerHandle;
  protected ticking?: Promise<void>;
  protected grace = 0;

  public async resolve(): Promise<void> {
    const config = resolveWorkflowConfig(this.RawConfig);
    this.grace = config.shutdownGrace;
    this.Engine = await DI.resolve(WorkflowEngine);
    if (config.enabled) this.handle = this.Timers.setInterval(() => this.beat(), config.tick);
    await super.resolve();
  }

  /** Waits for the tick in flight too, at most the grace: none of its writes or releases may land after the ORM is gone. */
  public async dispose(): Promise<void> {
    this.stopLoop();
    const ac = new AbortController();
    await Promise.race([Promise.allSettled([this.Engine?.stop(), this.ticking]), this.Timers.sleep(this.grace, ac.signal)]);
    ac.abort();
  }

  protected beat(): void {
    if (this.ticking) return;
    this.ticking = this.Engine.tick()
      .catch((err: unknown) => this.tickFailed(err))
      .finally(() => {
        this.ticking = undefined;
      });
  }

  protected tickFailed(err: unknown): void {
    // crash contract: the replica is dead, so it claims nothing more; its leases expire on their own
    if (!isCrash(err)) {
      this.Log.error(err as Error, 'workflow tick failed');
      return;
    }
    this.stopLoop();
    this.Log.error(err as Error, 'workflow tick crashed; the replica is dead and its worker loop stopped');
  }

  protected stopLoop(): void {
    if (this.handle !== undefined) this.Timers.clearInterval(this.handle);
    this.handle = undefined;
  }
}
