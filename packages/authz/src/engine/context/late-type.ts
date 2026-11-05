import { quote } from '@spinajs/util';
import { AuthzConfigError, UnknownPermission } from '../../contracts/errors.js';
import type { Permission, PermissionDef } from '../../contracts/permission.js';
import type { ResourceRef, ResourceType } from '../../contracts/principal.js';
import type { ResourceAdapter } from '../../contracts/adapter.js';
import { isObject } from '../internal/util.js';
import { copyRef } from '../vote.js';
import { GLOBAL_TYPE } from '../types.js';
import type { Engine } from '../types.js';

/**
 * Adapters such as authz-orm's list their types live, but the constructor
 * indexed them once: a type listed only now has no adapter here (no load,
 * ancestors or attributes), so every use of it throws until a reboot.
 */
export function refuseLateType(engine: Engine, type: ResourceType): void {
  const adapter = lateType(engine, type);
  if (adapter) throw lateTypeError(engine, type, adapter, AuthzConfigError);
}

/** An unknown permission that a late type's adapter lists now throws the late-type error instead. */
export function requirePermission(engine: Engine, name: Permission): PermissionDef {
  try {
    return engine.registry.require(name);
  } catch (e) {
    if (!(e instanceof UnknownPermission)) throw e;
    for (const adapter of engine.adapterList) {
      let types: unknown;
      try {
        const listed: unknown = typeof adapter.permissions === 'function' ? adapter.permissions() : undefined;
        const def: unknown = Array.isArray(listed) ? listed.find((d: unknown) => isObject(d) && d.name === name) : undefined;
        types = isObject(def) ? def.types : undefined;
      } catch {
        continue;
      }
      if (!Array.isArray(types)) continue;
      for (const type of types) {
        const late = typeof type === 'string' ? lateType(engine, type) : undefined;
        if (late) throw lateTypeError(engine, type as ResourceType, late, UnknownPermission);
      }
    }
    throw e;
  }
}

/** The adapter whose live `types` lists `type` although the constructor did not index it; an adapter whose types cannot be read is passed over. */
export function lateType(engine: Engine, type: ResourceType): ResourceAdapter | undefined {
  if (type === GLOBAL_TYPE || engine.adapterByType.has(type)) return undefined;
  for (const adapter of engine.adapterList) {
    try {
      const types: unknown = adapter.types;
      if (Array.isArray(types) && types.includes(type)) return adapter;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function lateTypeError(engine: Engine, type: ResourceType, adapter: ResourceAdapter, kind: typeof AuthzConfigError): AuthzConfigError {
  let name: unknown;
  try {
    name = adapter.kind;
  } catch {
    name = '<unreadable>';
  }
  return new kind(`${engine.where}: resource type ${quote(type)} was registered with adapter ${quote(name)} after the domain booted; register it before boot, or boot the domain again`);
}

export function requireRef(engine: Engine, v: unknown): ResourceRef {
  const ref = copyRef(v);
  if (!ref) throw new AuthzConfigError(`${engine.where}: expected a ResourceRef`);
  return ref;
}
