import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

const open: IContainer[] = [];

/** The resolved Configuration of a child container with these schemas and values, so its validation has run. */
export async function boot(schemas: readonly object[], values: Record<string, unknown>): Promise<Configuration> {
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values)).as(Configuration);
  return child.resolve(Configuration);
}

/** The full paths of the violations the boot reports; [] when it succeeds. */
export async function violationsOf(schemas: readonly object[], values: Record<string, unknown>): Promise<string[]> {
  try {
    await boot(schemas, values);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
}

export async function disposeBooted(): Promise<void> {
  for (const c of open.splice(0)) await c.dispose();
}
