import { DI, IContainer } from '@spinajs/di';
import { Configuration, IConfigurationSchema } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from './configuration.js';
import { InvalidConfiguration } from './exception.js';
import { sameSchema } from './util.js';

const SCHEMAS = '__configurationSchema__';

/** The schema as `container` holds it: registering it again, or a copy with its `$id`, adds nothing. */
function registerOnce(schema: IConfigurationSchema, container: IContainer): IConfigurationSchema {
  const registered = (container.Cache.get(SCHEMAS, false) ?? []) as IConfigurationSchema[];
  const known = registered.find((s) => sameSchema(s, schema));
  if (known) return known;
  container.register(schema).asValue(SCHEMAS);
  return schema;
}

/** The resolved Configuration of the nearest container in the lineage of `container` that registers one. */
function resolvedConfigurationOf(container: IContainer): FrameworkConfiguration | undefined {
  let owner: IContainer | undefined = container;
  while (owner && !owner.Registry.ownsRegistration(Configuration)) owner = owner.Parent;
  const resolved = owner?.get(Configuration, false);
  return resolved instanceof FrameworkConfiguration ? resolved : undefined;
}

/**
 * Registers a configuration schema. When the Configuration that `container` reads (the one of the nearest
 * container in its lineage that registers a Configuration) is already resolved, the schema is validated against
 * it at once and a refused value throws InvalidConfiguration; a Configuration that is registered but not resolved
 * yet applies the schema when it boots.
 */
export function registerConfigurationSchema(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void {
  const registered = registerOnce(schema, container);
  resolvedConfigurationOf(container)?.validateModule(registered);
}

/**
 * Registers a schema from a module's top level, so a module loaded after the Configuration
 * resolved (a directory scan, a CLI command) still gets its values checked and defaulted. A refused value does not
 * fail the import, which would take down every module loaded with it: the violations are logged, and each read of
 * the module throws InvalidConfiguration until it validates. A Bootstrapper that registers the same schema keeps doing
 * so: DI.clearCache() drops this registration, and a module's top level runs once per process.
 */
export function registerConfigurationSchemaAtImport(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void {
  try {
    registerConfigurationSchema(schema, container);
  } catch (e) {
    if (!(e instanceof InvalidConfiguration)) throw e;
  }
}
