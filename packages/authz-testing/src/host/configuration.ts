import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

/** A FrameworkConfiguration over `values` alone: no file or env source, so only the schemas validate and default it. */
export function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SchemaTestConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

export interface BootedConfiguration {
  /** A child of the parent that holds the Configuration; the caller disposes it. */
  readonly child: IContainer;
  readonly configuration: Configuration;
}

/**
 * `values` as the resolved Configuration of a fresh child of `parent`, with `schemas` registered there; the schemas of
 * the lineage apply too. Rejects with InvalidConfiguration, after disposing the child, for a value they refuse.
 */
export async function bootConfiguration(values: Record<string, unknown>, schemas: readonly IConfigurationSchema[] = [], parent: IContainer = DI.RootContainer): Promise<BootedConfiguration> {
  const child = parent.child();
  child.register(configurationOf(values)).as(Configuration);
  // After the Configuration: registered first, a schema would be validated at once against the parent's.
  for (const schema of schemas) registerConfigurationSchema(schema, child);
  try {
    return { child, configuration: (await child.resolve(Configuration)) as Configuration };
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** The `violations[].path` of the InvalidConfiguration that `boot` rejects with; any other outcome fails. */
export async function violationPaths(boot: Promise<unknown>): Promise<string[]> {
  let booted: unknown;
  try {
    booted = await boot;
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
  await (booted as Partial<BootedConfiguration> | undefined)?.child?.dispose();
  throw new Error('expected the configuration boot to fail with InvalidConfiguration, but it booted');
}

/** Makes the @Config properties of `instance`, built with `new`, read the Configuration of `container`. */
export function bindConfiguration<T extends object>(instance: T, container: IContainer): T {
  (instance as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  return instance;
}
