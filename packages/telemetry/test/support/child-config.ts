import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';

type Schema = Parameters<typeof registerConfigurationSchema>[0];

const booted: IContainer[] = [];

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class ChildConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** A child container with its own Configuration over `values`, resolved before anything reads it. */
export async function bootChild(values: Record<string, unknown>, ...schemas: Schema[]): Promise<{ child: IContainer; config: Configuration }> {
  const child = DI.RootContainer.child();
  booted.push(child);
  child.register(configurationOf(values)).as(Configuration);
  for (const schema of schemas) registerConfigurationSchema(schema, child);
  return { child, config: await child.resolve(Configuration) };
}

/** The `path` of every violation of a boot that must fail with InvalidConfiguration. */
export async function violationPaths(values: Record<string, unknown>, ...schemas: Schema[]): Promise<string[]> {
  try {
    await bootChild(values, ...schemas);
  } catch (e) {
    if (!(e instanceof InvalidConfiguration)) throw e;
    return e.violations.map((v) => v.path);
  }
  throw new Error('expected InvalidConfiguration, the boot succeeded');
}

export async function disposeChildren(): Promise<void> {
  for (const c of booted.splice(0).reverse()) await c.dispose();
}
