import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

export function configurationOf(values: Record<string, unknown>, env = 'test'): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

export interface Booted {
  readonly child: IContainer;
  readonly configuration: Configuration;
}

const open: IContainer[] = [];

/** A child container with these schemas and values; the Configuration is resolved, so its validation has run. */
export async function boot(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<Booted> {
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values, env)).as(Configuration);
  return { child, configuration: await child.resolve(Configuration) };
}

/** The full paths of the violations the boot reports; [] when it succeeds. */
export async function violationsOf(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<string[]> {
  try {
    await boot(schemas, values, env);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
}

export async function disposeBooted(): Promise<void> {
  for (const c of open.splice(0)) await c.dispose();
}
