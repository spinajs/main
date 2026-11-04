import { createHash } from 'node:crypto';
import { canonicalize } from '@spinajs/manifest';
import { clientSchema } from '../dto-types.js';
import type { ClientModel, RouteModel } from '../model.js';
import type { TypeContext } from '../ts-type.js';

// They change no data a cache holds. Dropped only here: client.ts prints `description` as JSDoc.
const ANNOTATIONS: ReadonlySet<string> = new Set(['description', '$comment', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

// Keyed by type name, not schema id, so moving a DTO to another package does not bust caches.
function replySchemas(route: RouteModel, ctx: TypeContext): Record<string, unknown> {
  const schemas = new Map<string, unknown>();
  const pending = route.returnSchema !== undefined ? [route.returnSchema] : [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const name = ctx.nameOf(id);
    if (schemas.has(name)) continue;
    const reference = (ref: string) => {
      pending.push(ref);
      return ctx.nameOf(ref);
    };
    schemas.set(name, clientSchema(ctx.schemaOf(id), reference, ANNOTATIONS));
  }
  return Object.fromEntries(schemas);
}

/** Changes only with a route name, an argument name or a reply schema: what a persisted query cache depends on. */
export function clientShapeHash(model: ClientModel): string {
  const routes = model.controllers
    .flatMap((c) => c.routes.filter((r) => r.kind !== 'none').map((r) => ({ route: `${c.key}.${r.name}`, args: r.args.map((a) => a.name).sort(), returns: r.returns, schemas: replySchemas(r, model.ctx) })))
    .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  return createHash('sha256').update(canonicalize(routes)).digest('hex');
}
