import { AsyncService, DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ListFromFiles } from '@spinajs/reflection';
import { DataValidator } from '@spinajs/validation';
import { ScheduleNotFound } from '../contract.js';
import { getBuiltinDeclarations, getScheduleDeclarations } from '../decorators.js';
import { resolveSchedulerConfig, ScheduleDefinition, SchedulerConfig } from '../interfaces.js';
import { buildDefinitions } from './definitions.js';

@Singleton()
@Injectable()
export class ScheduleRegistry extends AsyncService {
  @Config('scheduler', { defaultValue: {} })
  protected RawConfig: Partial<SchedulerConfig>;

  // Listing the files imports them, which runs their @Schedule decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.schedules')
  protected ScheduleFiles: Promise<unknown[]>;

  public config: SchedulerConfig;

  protected definitions = new Map<string, ScheduleDefinition>();

  public async resolve(): Promise<void> {
    await this.ScheduleFiles;
    this.config = resolveSchedulerConfig(this.RawConfig);
    const validator = await DI.resolve(DataValidator);

    const defs = buildDefinitions({
      declarations: [...getScheduleDeclarations(), ...getBuiltinDeclarations(this.config)],
      config: this.config.schedules,
      tickMs: this.config.tick,
      validateParamsSchema: (schema) => {
        const [ok, errors] = validator.validateSchema(schema);
        return ok ? null : (errors ?? []).map((e) => e.message ?? e.keyword).join('; ');
      },
    });

    this.definitions = new Map(defs.map((d) => [d.name, d]));
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
