import type { AdminContext, AuthzAdminQuery, AuthzEvent, AuthzTx } from '../contracts/admin.js';
import { ScopeAttributeStore } from '../contracts/adapter.js';
import type { PrincipalRef, ResourceRef } from '../contracts/principal.js';

/**
 * AuthzWriteHandler.apply may return, beside the contract fields, `row`: the record the command wrote
 * (the Assignment of assignment.grant, the LinkDef of link.create). AuthzAdmin keeps it out of the
 * command result and hands it to the sugar methods (assign, createLink), which fail without it.
 */
export interface AppliedRow {
  readonly row?: unknown;
}

/**
 * list() support for one or more query kinds; registered by the model that owns the data. AuthzAdmin
 * checks the read permission first and passes a page ({ limit, offset }) for every kind but 'attributes'.
 */
export abstract class AuthzAdminReader {
  abstract readonly kinds: readonly AuthzAdminQuery['kind'][];
  abstract list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }>;
}

/** scope.forget fans out to every registered forgetter, inside the batch transaction. */
export abstract class ScopeForgetter {
  abstract forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }>;
}

export type ScopeAttributeLeaf = string | number | boolean;

/** Registered under both ScopeAttributeStore (the engine reads it) and this token (the admin writes it). */
export abstract class WritableScopeAttributeStore extends ScopeAttributeStore {
  /** Flat leaf rows of one node, path → JSON scalar. */
  abstract rows(ref: ResourceRef): Promise<Readonly<Record<string, ScopeAttributeLeaf>>>;
  /** set: path → scalar (insert or replace); remove: paths (and every path below them). */
  abstract write(ref: ResourceRef, change: { readonly set: Readonly<Record<string, ScopeAttributeLeaf>>; readonly remove: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<number>;
  abstract forget(ref: ResourceRef, tx: AuthzTx): Promise<number>;
}
