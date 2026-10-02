// Data shapes owned by the RBAC/ABAC models, declared here because AuthzCommand carries them; authz-rbac and authz-abac re-export them.
import type { Condition } from '../conditions/contracts.js';
import type { DenyReason, FieldSet } from './decision.js';
import type { PrincipalRef, PrincipalType, ResourceRef, ResourceType } from './principal.js';

/** Subject of an assignment: a principal, or the set of holders of `role` at `scope` (one level; never nested). */
export type AssignmentSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };

export interface Assignment {
  readonly id: string;
  readonly subject: AssignmentSubject;
  readonly role: string;
  readonly scope: ResourceRef;
  readonly tags?: readonly string[]; // add-ons
  readonly expiresAt?: Date | null;
  readonly grantedBy?: PrincipalRef;
  readonly source: string;
}

/** Which principals a rule applies to; all fields AND. */
export interface SubjectSelector {
  readonly principalTypes?: readonly PrincipalType[]; // the principal or a companion has one of these types
  readonly actorTypes?: readonly PrincipalType[];
  readonly refs?: readonly PrincipalRef[];
  readonly rank?: { readonly ladder: string; readonly at: ResourceType; readonly lt?: string; readonly eq?: string; readonly gte?: string }; // effective rank at the nearest ancestor of type `at`; no role = below every role
  readonly when?: Condition;
}

/** RBAC rules (D15). */
export interface RuleDef {
  readonly id: string;
  readonly kind: 'restrict' | 'cap' | 'threshold';
  readonly scope: ResourceRef; // applies at this node and below; GLOBAL for config rules
  readonly resourceTypes?: readonly ResourceType[]; // only requests on these types (branch rules: ['branch'])
  readonly subjects?: SubjectSelector;
  readonly when?: Condition; // principal.*, actor.*, env.*, scope.*, resource.* refs
  readonly expiresAt?: Date | null;
  readonly source: string;
  // restrict: assignments made strictly above `scope` are dropped unless their subject matches `allow`
  readonly allow?: readonly AssignmentSubject[];
  // cap: clamp rank and/or strip tags of matching assignments
  readonly ladder?: string;
  readonly maxRole?: string | { readonly ref: string } | null; // null drops the assignment
  readonly stripTags?: boolean;
  readonly assignments?: { readonly scopeTypes?: readonly ResourceType[]; readonly subjectTypes?: readonly PrincipalType[] };
  // threshold: matching permissions need rank >= minRole (deciding rank of the permission, or `ladder` at `at`)
  readonly permissions?: readonly string[];
  readonly resource?: Condition; // e.g. { attr: 'resource.name', wildcard: 'release/*' }
  readonly minRole?: string | { readonly ref: string };
  readonly at?: ResourceType;
  readonly reason?: Omit<DenyReason, 'model'>; // code, payload, priority, sortKey
}

/** Share link: bearer secret + scope + expiry; its grant is an assignment to link:<id>. */
export interface LinkDef {
  readonly id: string;
  readonly scope: ResourceRef;
  readonly expiresAt?: Date | null;
  readonly attributes: Readonly<Record<string, unknown>>; // e.g. { org_only: true }
  readonly createdBy?: PrincipalRef;
}

export interface Policy {
  readonly id: string;
  readonly effect: 'permit' | 'deny';
  readonly permissions: readonly string[]; // globs
  readonly resourceTypes?: readonly ResourceType[];
  readonly principalTypes?: readonly PrincipalType[];
  readonly actorTypes?: readonly PrincipalType[]; // matches DecisionRequest.actor (agents under 'inherit')
  readonly scope?: ResourceRef; // applies at this node and below (per-org policies)
  readonly when?: Condition;
  readonly fields?: FieldSet;
  readonly reason?: string;
  readonly priority?: number; // default 500
  readonly expiresAt?: Date | null;
  readonly source: string;
}
