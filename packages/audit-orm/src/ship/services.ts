import { AuditConfigError } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** The service of `type` registered as `name` in the root container; `option` is the configuration path that named it. */
export async function namedService<T>(type: Class<T>, name: string, option: string): Promise<T> {
  const registered = DI.RootContainer.getRegisteredNames(type);
  if (!registered.includes(name)) throw new AuditConfigError(`audit: ${option} names ${JSON.stringify(name)}, but no ${type.name} is registered under that name (registered: ${registered.join(', ') || 'none'})`);
  return DI.RootContainer.resolveNamed(type, name);
}

/** Every driver once: `Orm.Connections` also lists `default` and the aliases of a driver. */
export function distinctConnections(): OrmDriver[] {
  return [...new Set(DI.get(Orm)?.Connections.values() ?? [])];
}
