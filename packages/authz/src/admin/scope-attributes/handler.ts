import { Injectable, Singleton } from '@spinajs/di';

import { AuthzAdminFailure, AuthzWriteHandler } from '../../contracts/admin.js';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx } from '../../contracts/admin.js';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { Permission } from '../../contracts/permission.js';
import type { PrincipalRef, ResourceRef, ResourceType } from '../../contracts/principal.js';
import type { ScopeAttributeSchema } from '../../contracts/adapter.js';
import { GLOBAL, resourceKey } from '../../contracts/resource.js';
import { mergeAttributes } from '../../engine/attributes.js';
import { adminActor, adminContainer } from '../context.js';
import { WritableScopeAttributeStore } from '../ports.js';
import type { ScopeAttributeLeaf } from '../ports.js';
import { SCOPE_ATTRIBUTE_LIMITS, flattenAttributes, underPath, unflattenAttributes } from './flatten.js';
import { contributedSchemas, errorPath, schemaValidator } from './schemas.js';

type AttributeCommand = Extract<AuthzCommand, { kind: 'scope.setAttributes' | 'scope.replaceAttributes' }>;
type Rows = Record<string, ScopeAttributeLeaf>;

interface Plan {
  readonly scope: ResourceRef;
  readonly store: WritableScopeAttributeStore;
  readonly set: Rows;
  readonly remove: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

// One AdminCallContext per batch: its commands share the contributors' answer, in validate and in apply.
const batchSchemas = new WeakMap<AdminContext, Promise<ReadonlyMap<ResourceType, ScopeAttributeSchema>>>();

function scopeOf(c: AttributeCommand): ResourceRef {
  const scope: unknown = c.scope;
  if (!isObject(scope) || typeof scope.type !== 'string' || scope.type === '' || (scope.id !== undefined && typeof scope.id !== 'string')) throw new AuthzAdminFailure('invalid_attributes', 'scope must be a resource ref', 'scope');
  if (scope.type === GLOBAL.type) throw new AuthzAdminFailure('invalid_attributes', 'GLOBAL has no scope attributes', 'scope');
  if (scope.id === undefined || scope.id === '') throw new AuthzAdminFailure('invalid_attributes', `scope attributes belong to one node; ${JSON.stringify(scope.type)} names no id`, 'scope');
  const id = scope.id as string;
  if (scope.type.length > SCOPE_ATTRIBUTE_LIMITS.scopeType || id.length > SCOPE_ATTRIBUTE_LIMITS.scopeId) throw new AuthzAdminFailure('invalid_attributes', `a scope type and id are at most ${SCOPE_ATTRIBUTE_LIMITS.scopeType} characters each`, 'scope');
  return { type: scope.type, id };
}

/** The rows after the change: a removed path takes its subtree; a set path replaces its ancestors' and descendants' rows. */
function nextRows(old: Readonly<Rows>, set: Readonly<Rows>, remove: readonly string[]): Rows {
  const next: Rows = { ...old };
  for (const p of remove) for (const path of Object.keys(next)) if (underPath(path, p)) delete next[path];
  for (const [p, v] of Object.entries(set)) {
    for (const path of Object.keys(next)) if (underPath(path, p) || underPath(p, path)) delete next[path];
    next[p] = v;
  }
  return next;
}

/** scope.setAttributes (deep merge, null removes a subtree) and scope.replaceAttributes, validated against the scope type's schema. */
@Singleton()
@Injectable(AuthzWriteHandler)
export class ScopeAttributeHandler extends AuthzWriteHandler {
  readonly kinds = ['scope.setAttributes', 'scope.replaceAttributes'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    await this.plan(c, ctx);
  }

  permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef } {
    return { permission: 'authz:scope.manage', resource: scopeOf(c as AttributeCommand) };
  }

  // Planned again inside the transaction: an earlier command of the batch may have changed the rows.
  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const p = await this.plan(c, ctx);
    const actor = adminActor(ctx);
    const by: PrincipalRef = { type: actor.type, id: actor.id };
    const paths = [...Object.keys(p.set), ...p.remove].sort();
    // Nothing changed: no write, no version change, nothing to invalidate or announce.
    if (paths.length === 0) return { affected: 0, tags: [], events: [] };
    const affected = await p.store.write(p.scope, { set: p.set, remove: p.remove }, by, tx);
    return {
      affected,
      tags: [`scope:${resourceKey(p.scope)}`],
      events: [{ type: 'ScopeAttributesChanged', domain: ctx.domain, actor: by, at: ctx.now, data: { scope: p.scope, paths } }],
    };
  }

  private async plan(command: AuthzCommand, ctx: AdminContext): Promise<Plan> {
    const c = command as AttributeCommand;
    if (c.kind !== 'scope.setAttributes' && c.kind !== 'scope.replaceAttributes') throw new AuthzConfigError(`ScopeAttributeHandler cannot handle ${JSON.stringify((c as { kind?: unknown }).kind)}`);
    const scope = scopeOf(c);
    const replace = c.kind === 'scope.replaceAttributes';
    const change = replace ? flattenAttributes(c.attributes, { field: 'attributes' }) : flattenAttributes(c.patch, { nulls: true, field: 'patch' });

    const where = `Authz domain ${JSON.stringify(ctx.domain)}`;
    const container = adminContainer(ctx);
    let schemas = batchSchemas.get(ctx);
    if (!schemas) batchSchemas.set(ctx, (schemas = contributedSchemas(container, ctx.domain, where)));
    const schema = (await schemas).get(scope.type);
    if (!schema) throw new AuthzAdminFailure('invalid_attributes', `no scope attribute schema for type ${JSON.stringify(scope.type)}`, 'scope');
    if (!container.hasRegistered(WritableScopeAttributeStore)) throw new AuthzConfigError(`${where}: no WritableScopeAttributeStore is registered; scope attributes cannot be written`);
    const store = (await container.resolve(WritableScopeAttributeStore)) as WritableScopeAttributeStore;
    if (!isObject(store) || typeof store.rows !== 'function' || typeof store.write !== 'function') throw new AuthzConfigError(`${where}: the resolved WritableScopeAttributeStore has no rows() and write()`);

    const old: Rows = { ...(await store.rows(scope)) };
    const next = replace ? change.set : nextRows(old, change.set, change.remove);
    if (Object.keys(next).length > SCOPE_ATTRIBUTE_LIMITS.leaves) throw new AuthzAdminFailure('invalid_attributes', `a scope holds at most ${SCOPE_ATTRIBUTE_LIMITS.leaves} attribute values`, replace ? 'attributes' : 'patch');
    const validate = schemaValidator(schema.schema, scope.type);
    if (!validate(mergeAttributes([schema.defaults, unflattenAttributes(next)]))) {
      const e = validate.errors?.[0];
      const path = e ? errorPath(e) : '';
      throw new AuthzAdminFailure('invalid_attributes', `${path === '' ? 'the attributes' : `attribute ${path}`} ${e?.message ?? 'do not match the schema'} (schema of ${JSON.stringify(scope.type)})`, path === '' ? (replace ? 'attributes' : 'patch') : path);
    }

    const set: Rows = {};
    for (const [path, v] of Object.entries(next)) if (!Object.hasOwn(old, path) || old[path] !== v) set[path] = v;
    const remove = Object.keys(old).filter((path) => !Object.hasOwn(next, path));
    return { scope, store, set, remove };
  }
}
