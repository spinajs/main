import { AuthzAdminFailure, AuthzWriteHandler } from '@spinajs/authz';
import type { AdminContext, AppliedRow, AuthzCommand, AuthzEvent, AuthzTx, Permission, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { LinkDef } from '../contracts.js';
import { actorRef, assignmentStore, checkGrantable, event, linkGrants, linkStore, linkTags, plannedRemovals, quote, readAttributes, readFutureExpiry, readId, readNode, readOptionalTags, roleIndex } from './common.js';
import { refreshMemberships } from './membership.js';

type Cmd<K extends AuthzCommand['kind']> = Extract<AuthzCommand, { kind: K }>;
type Applied = { id?: string; token?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] } & AppliedRow;

const MANAGE: Permission = 'authz:links.manage';

/** link.create, link.update, link.revoke; a link's grant is an assignment of subject link:<id> at the link's scope. */
@Singleton()
@Injectable(AuthzWriteHandler)
export class RbacLinkHandler extends AuthzWriteHandler {
  readonly kinds = ['link.create', 'link.update', 'link.revoke'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    switch (c.kind) {
      case 'link.create':
        await this.createOf(c, ctx);
        return;
      case 'link.update':
        await this.updateOf(c, ctx, await this.link(c, ctx));
        return;
      case 'link.revoke':
        readId(c.id);
        return;
      default:
        throw new AuthzAdminFailure('not_found', `RbacLinkHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    }
  }

  async permission(c: AuthzCommand, ctx: AdminContext): Promise<{ permission: Permission; resource: ResourceRef }> {
    if (c.kind === 'link.create') return { permission: MANAGE, resource: readNode(c.scope, 'scope') };
    return { permission: MANAGE, resource: (await this.link(c as Cmd<'link.revoke'>, ctx)).scope };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const links = await linkStore(ctx);
    const actor = actorRef(ctx);
    switch (c.kind) {
      case 'link.create': {
        const l = await this.createOf(c, ctx);
        const { link, token } = await links.create({ scope: l.scope, expiresAt: l.expiresAt, attributes: l.attributes, createdBy: actor }, { role: l.role, tags: l.tags }, actor, tx);
        const membership = await refreshMemberships(ctx, tx, [{ type: 'link', id: link.id }]);
        return { id: link.id, token, affected: 1, tags: [...linkTags(link.id), ...membership], events: [event(ctx, 'LinkCreated', { id: link.id, scope: link.scope, role: l.role, expiresAt: link.expiresAt ?? null })], row: link };
      }
      case 'link.update': {
        const link = await this.link(c, ctx);
        const u = await this.updateOf(c, ctx, link);
        if (Object.values(u).every((v) => v === undefined)) return { id: link.id, affected: 0, tags: [], events: [] };
        let next = link;
        if (u.expiresAt !== undefined || u.attributes !== undefined) next = await links.update(link.id, { expiresAt: u.expiresAt, attributes: u.attributes }, actor, tx);
        const grant = await this.regrant(c, link, u, ctx, tx);
        const membership = await refreshMemberships(ctx, tx, [{ type: 'link', id: link.id }]);
        return { id: link.id, affected: 1, tags: [...linkTags(link.id), ...membership], events: [event(ctx, 'LinkUpdated', { id: link.id, scope: next.scope, role: grant.role, tags: grant.tags, expiresAt: next.expiresAt ?? null })] };
      }
      case 'link.revoke': {
        const link = await this.link(c, ctx);
        await links.revoke(link.id, actor, tx);
        const membership = await refreshMemberships(ctx, tx, [{ type: 'link', id: link.id }]);
        return { id: link.id, affected: 1, tags: [...linkTags(link.id), ...membership], events: [event(ctx, 'LinkRevoked', { id: link.id, scope: link.scope })] };
      }
      default:
        throw new AuthzAdminFailure('not_found', `RbacLinkHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    }
  }

  private async createOf(c: Cmd<'link.create'>, ctx: AdminContext): Promise<{ scope: ResourceRef; role: string; tags: string[]; expiresAt: Date | null; attributes: Record<string, unknown> }> {
    const scope = readNode(c.scope, 'scope');
    const role = checkGrantable(await roleIndex(ctx), c.role, scope).name;
    return { scope, role, tags: readOptionalTags(c.tags) ?? [], expiresAt: readFutureExpiry(c.expiresAt, ctx) ?? null, attributes: readAttributes(c.attributes) ?? {} };
  }

  private async updateOf(c: Cmd<'link.update'>, ctx: AdminContext, link: LinkDef): Promise<{ role?: string; tags?: string[]; expiresAt?: Date | null; attributes?: Record<string, unknown> }> {
    const role = c.role === undefined ? undefined : checkGrantable(await roleIndex(ctx), c.role, link.scope).name;
    return { role, tags: readOptionalTags(c.tags), expiresAt: readFutureExpiry(c.expiresAt, ctx), attributes: readAttributes(c.attributes) };
  }

  /** A new role replaces the link's assignment (role is part of its identity); new tags update it in place. */
  private async regrant(c: Cmd<'link.update'>, link: LinkDef, u: { role?: string; tags?: string[] }, ctx: AdminContext, tx: AuthzTx): Promise<{ role: string | null; tags: readonly string[] }> {
    const store = await assignmentStore(ctx);
    const actor = actorRef(ctx);
    const subject = { type: 'link', id: link.id };
    const current = (await linkGrants(link.id, ctx, true))?.[0];
    if (u.role !== undefined && u.role !== current?.role) {
      for (const a of (await plannedRemovals(c, ctx)).revoke) await store.revoke(a.id, actor, tx);
      const row = await store.assign({ subject, role: u.role, scope: link.scope, tags: u.tags ?? current?.tags ?? [], expiresAt: null }, actor, tx);
      return { role: row.role, tags: row.tags ?? [] };
    }
    if (u.tags !== undefined) {
      if (!current) throw new AuthzAdminFailure('conflict', `link ${quote(link.id)} grants no role whose tags could change`, 'tags');
      const row = await store.update(current.id, { tags: u.tags }, actor, tx);
      return { role: row.role, tags: row.tags ?? [] };
    }
    return { role: current?.role ?? null, tags: current?.tags ?? [] };
  }

  private async link(c: { readonly id: unknown }, ctx: AdminContext): Promise<LinkDef> {
    const id = readId(c.id);
    const link = await (await linkStore(ctx)).byId(id);
    if (!link) throw new AuthzAdminFailure('not_found', `no link ${quote(id)}`, 'id');
    return link;
  }
}
