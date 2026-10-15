import { AsyncService, DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';
import { ListFromFiles } from '@spinajs/reflection';
import { DataValidator } from '@spinajs/validation';
import { ScheduleNotFound } from '../contract.js';
import { getBuiltinDeclarations, getScheduleDeclarations } from '../decorators.js';
import { resolveSchedulerConfig, ScheduleDefinition, SchedulerConfig } from '../interfaces.js';
import { buildDefinitions } from './definitions.js';
import { loadTaskMethodLookup } from '../tasks/task-methods.js';
import { blackHoleConnections, type QueueRoutingConfig } from '../emit/routing.js';
// the built-in retention schedule, also in processes that never load the index (CLI)
import '../retention/SchedulerRetentionTask.js';

@Singleton()
@Injectable()
export class ScheduleRegistry extends AsyncService {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Config('scheduler', { defaultValue: {} })
  protected RawConfig: Partial<SchedulerConfig>;

  @Config('queue', { defaultValue: {} })
  protected QueueConfig: QueueRoutingConfig;

  // Listing the files imports them, which runs their @Schedule decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.schedules')
  protected ScheduleFiles: Promise<unknown[]>;

  public config: SchedulerConfig;

  protected definitions = new Map<string, ScheduleDefinition>();

  public async resolve(): Promise<void> {
    await this.ScheduleFiles;
    this.config = resolveSchedulerConfig(this.RawConfig);
    const validator = await DI.resolve(DataValidator);

    const declarations = [...getScheduleDeclarations(), ...getBuiltinDeclarations(this.config)];
    const classNames = new Set(declarations.map((d) => d.target.name));
    // importing @spinajs/tasks registers its __tasks migration, so only when config names a @Task
    const needsTaskMethods = this.config.schedules.some((s) => !!s.task && !classNames.has(s.task));

    const defs = buildDefinitions({
      declarations,
      config: this.config.schedules,
      tickMs: this.config.tick,
      findTaskMethods: needsTaskMethods ? await loadTaskMethodLookup() : undefined,
      validateParamsSchema: (schema) => {
        const [ok, errors] = validator.validateSchema(schema);
        return ok ? null : (errors ?? []).map((e) => e.message ?? e.keyword).join('; ');
      },
    });

    this.definitions = new Map(defs.map((d) => [d.name, d]));
    for (const d of defs) {
      if (d.runOn === 'all' && d.retry) {
        this.Log.warn(
          `schedule ${d.name}: retry is ignored for runOn 'all'; a failed local run waits for the next occurrence`,
        );
      }
      if (d.emit && d.retry) {
        this.Log.warn(`schedule ${d.name}: retry is ignored in emit mode; the queue retries the job`);
      }
      if (d.emit) {
        for (const c of blackHoleConnections(d.emit.name, this.QueueConfig)) {
          this.Log.warn(
            `schedule ${d.name}: job ${d.emit.name} routes to queue connection '${c}' (BlackHoleQueueClient); its jobs are dropped and the runs fail after emitTimeout`,
          );
        }
      }
    }
    await super.resolve();
  }

  public all(): ScheduleDefinition[] {
    return [...this.definitions.values()];
  }

  public find(name: string): ScheduleDefinition | undefined {
    return this.definitions.get(name);
  }

  public get(name: string): ScheduleDefinition {
    const def = this.definitions.get(name);
    if (!def) throw new ScheduleNotFound(name);
    return def;
  }
}
