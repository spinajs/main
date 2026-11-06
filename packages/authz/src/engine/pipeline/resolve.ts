import { quote } from '@spinajs/util';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { PermissionDef } from '../../contracts/permission.js';
import type { ResourceRef } from '../../contracts/principal.js';
import { isObject } from '../internal/util.js';
import type { Pipeline } from '../run.js';
import { copyRef } from '../vote.js';
import { refShaped } from '../support/misc.js';
import type { Engine } from '../types.js';

export function* resolveResource(engine: Engine, resource: unknown, subject: unknown, def: PermissionDef): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
  if (resource === undefined) return { ref: Object.freeze({ type: def.resource }), subject };
  const resolved = yield* resolveObject(engine, resource);
  return { ref: resolved.ref, subject: subject === undefined ? resolved.subject : subject };
}

export function* resolveObject(engine: Engine, resource: unknown): Pipeline<{ readonly ref: ResourceRef; readonly subject: unknown }> {
  if (!isObject(resource)) throw new AuthzConfigError(`${engine.where}: a resource must be a ResourceRef or an object an adapter accepts, got ${resource === null ? 'null' : typeof resource}`);
  for (const adapter of engine.adapterList) {
    if (adapter.accepts(resource) !== true) continue;
    const ref = copyRef(yield adapter.refOf(resource));
    if (!ref) throw new AuthzConfigError(`${engine.where}: adapter ${quote(adapter.kind)} returned a malformed ref from refOf()`);
    return { ref, subject: resource };
  }
  const ref = refShaped(resource);
  if (!ref) throw new AuthzConfigError(`${engine.where}: the resource is neither accepted by an adapter nor a ResourceRef ({ type, id? } with a string id or null)`);
  return { ref, subject: undefined };
}
