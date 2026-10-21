// The core's own admin command and query shapes. RBAC and ABAC declare theirs in @spinajs/authz-rbac and
// @spinajs/authz-abac, which add them to AuthzCommandMap and AuthzAdminQueryMap (admin.ts) by module augmentation.
import type { ResourceRef } from './principal.js';

/** Deep-merges `patch` into the attributes of `scope`; null deletes a path. */
export interface ScopeSetAttributesCommand {
  readonly kind: 'scope.setAttributes';
  readonly scope: ResourceRef;
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface ScopeReplaceAttributesCommand {
  readonly kind: 'scope.replaceAttributes';
  readonly scope: ResourceRef;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Lifecycle of a scope node (project or file deleted): removes everything held AT this scope. */
export interface ScopeForgetCommand {
  readonly kind: 'scope.forget';
  readonly scope: ResourceRef;
}

/** The stored attributes of a scope node. */
export interface ScopeAttributesQuery {
  readonly kind: 'attributes';
  readonly scope: ResourceRef;
}
